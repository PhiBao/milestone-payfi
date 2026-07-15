// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Transfer {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IMilestoneEscrow {
    function markEarlyPaid(uint256 milestoneId) external;
    function release(uint256 milestoneId) external;
    function milestones(uint256 milestoneId)
        external
        view
        returns (
            address freelancer,
            address client,
            uint256 amount,
            uint64 releaseAfter,
            uint8 status,
            address repaymentTarget,
            bytes32 metadataHash
        );
}

contract ReceivablePool {
    uint8 public constant RISK_TIER_A = 0;
    uint8 public constant RISK_TIER_B = 1;
    uint8 public constant RISK_TIER_C = 2;
    uint8 public constant RISK_TIER_BLOCKED = 3;

    struct RiskPolicy {
        bool published;
        uint8 riskTier;
        uint16 maxAdvanceBps;
        uint16 baseDiscountBps;
        uint16 annualizedDiscountBps;
        uint16 maxDiscountBps;
        bytes32 riskHash;
    }

    IERC20Transfer public immutable usdc;
    IMilestoneEscrow public immutable escrow;
    address public owner;
    bool public paused;
    uint256 public outstanding;
    uint256 public utilizationCapBps = 6500;
    uint256 public maxAdvance = 3_500e6;
    uint256 public maxReceivableTenor = 45 days;
    uint256 public clientExposureCap = 5_000e6;
    uint256 public freelancerExposureCap = 5_000e6;
    uint256 public baseDiscountBps = 80;
    uint256 public annualizedDiscountBps = 2400;
    uint256 public maxDiscountBps = 600;
    uint256 public totalShares;

    mapping(uint256 => uint256) public advances;
    mapping(address => uint256) public sharesOf;
    mapping(uint256 => RiskPolicy) public riskPolicies;
    mapping(uint256 => address) public advanceClient;
    mapping(uint256 => address) public advanceFreelancer;
    mapping(address => uint256) public outstandingByClient;
    mapping(address => uint256) public outstandingByFreelancer;

    event Deposited(address indexed funder, uint256 amount, uint256 shares);
    event Withdrawn(address indexed funder, uint256 amount, uint256 shares);
    event AdvanceIssued(uint256 indexed milestoneId, address indexed freelancer, uint256 advanceAmount);
    event Repaid(uint256 indexed milestoneId, uint256 fullReceivableAmount, uint256 advanceAmount);
    event GuardrailsUpdated(uint256 utilizationCapBps, uint256 maxAdvance, uint256 discountBps, bool paused);
    event PricingUpdated(uint256 baseDiscountBps, uint256 annualizedDiscountBps, uint256 maxDiscountBps);
    event RiskLimitsUpdated(uint256 maxReceivableTenor, uint256 clientExposureCap, uint256 freelancerExposureCap);
    event RiskPolicySet(
        uint256 indexed milestoneId,
        uint8 riskTier,
        uint16 maxAdvanceBps,
        uint16 baseDiscountBps,
        uint16 annualizedDiscountBps,
        uint16 maxDiscountBps,
        bytes32 riskHash
    );

    error NotOwner();
    error NotEscrow();
    error NotFreelancer();
    error NotApproved();
    error PoolPaused();
    error CapExceeded();
    error ExposureExceeded();
    error FraudFlag();
    error InvalidAmount();
    error RiskBlocked();
    error RiskPolicyMissing();
    error TenorTooLong();
    error TransferFailed();

    constructor(address usdc_, address escrow_) {
        usdc = IERC20Transfer(usdc_);
        escrow = IMilestoneEscrow(escrow_);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();

        uint256 poolValueBefore = totalPoolValue();
        uint256 shares = totalShares == 0 || poolValueBefore == 0
            ? amount
            : (amount * totalShares) / poolValueBefore;
        if (shares == 0) revert InvalidAmount();

        sharesOf[msg.sender] += shares;
        totalShares += shares;

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount, shares);
    }

    function withdraw(uint256 shares) external {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert InvalidAmount();

        uint256 amount = (shares * totalPoolValue()) / totalShares;
        if (amount == 0 || amount > availableLiquidity()) revert CapExceeded();

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;

        if (!usdc.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount, shares);
    }

    function availableLiquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function totalPoolValue() public view returns (uint256) {
        return availableLiquidity() + outstanding;
    }

    function quoteDiscountBps(uint256 milestoneId) public view returns (uint256) {
        (,,, uint64 releaseAfter, uint8 status,,) = escrow.milestones(milestoneId);
        if (status != 3) return 0;
        RiskPolicy memory policy = riskPolicies[milestoneId];
        if (!policy.published || policy.riskTier == RISK_TIER_BLOCKED || policy.maxAdvanceBps == 0) return 0;

        uint256 maturityDiscountBps = 0;
        if (releaseAfter > block.timestamp) {
            maturityDiscountBps = ((uint256(releaseAfter) - block.timestamp) * policy.annualizedDiscountBps) / 365 days;
        }

        uint256 totalDiscountBps = policy.baseDiscountBps + maturityDiscountBps;
        return totalDiscountBps > policy.maxDiscountBps ? policy.maxDiscountBps : totalDiscountBps;
    }

    function quoteAdvance(uint256 milestoneId) public view returns (uint256) {
        (,, uint256 receivableAmount,, uint8 status,,) = escrow.milestones(milestoneId);
        if (status != 3) return 0;
        RiskPolicy memory policy = riskPolicies[milestoneId];
        if (!policy.published || policy.riskTier == RISK_TIER_BLOCKED || policy.maxAdvanceBps == 0) return 0;

        uint256 discountBps = quoteDiscountBps(milestoneId);
        uint256 discountedAmount = (receivableAmount * (10_000 - discountBps)) / 10_000;
        uint256 policyMaxAdvance = (receivableAmount * policy.maxAdvanceBps) / 10_000;
        return discountedAmount < policyMaxAdvance ? discountedAmount : policyMaxAdvance;
    }

    function requestAdvance(uint256 milestoneId) external {
        if (paused) revert PoolPaused();

        (address freelancer, address client, uint256 receivableAmount, uint64 releaseAfter, uint8 status,,) =
            escrow.milestones(milestoneId);
        if (freelancer != msg.sender) revert NotFreelancer();
        if (status != 3) revert NotApproved();
        if (client == freelancer) revert FraudFlag();
        if (releaseAfter > block.timestamp && uint256(releaseAfter) - block.timestamp > maxReceivableTenor) {
            revert TenorTooLong();
        }

        RiskPolicy memory policy = riskPolicies[milestoneId];
        if (!policy.published) revert RiskPolicyMissing();
        if (policy.riskTier == RISK_TIER_BLOCKED || policy.maxAdvanceBps == 0) revert RiskBlocked();

        uint256 advanceAmount = quoteAdvance(milestoneId);
        if (advanceAmount == 0 || advanceAmount > maxAdvance || advanceAmount >= receivableAmount) {
            revert CapExceeded();
        }
        if (advanceAmount > availableLiquidity()) revert CapExceeded();
        if (outstanding + advanceAmount > (totalPoolValue() * utilizationCapBps) / 10_000) {
            revert CapExceeded();
        }
        if (outstandingByClient[client] + advanceAmount > clientExposureCap) revert ExposureExceeded();
        if (outstandingByFreelancer[freelancer] + advanceAmount > freelancerExposureCap) revert ExposureExceeded();

        outstanding += advanceAmount;
        outstandingByClient[client] += advanceAmount;
        outstandingByFreelancer[freelancer] += advanceAmount;
        advances[milestoneId] = advanceAmount;
        advanceClient[milestoneId] = client;
        advanceFreelancer[milestoneId] = freelancer;
        escrow.markEarlyPaid(milestoneId);

        if (!usdc.transfer(freelancer, advanceAmount)) revert TransferFailed();
        emit AdvanceIssued(milestoneId, freelancer, advanceAmount);
    }

    function releaseReceivable(uint256 milestoneId) external {
        escrow.release(milestoneId);
    }

    function recordRepaymentFromEscrow(uint256 milestoneId, uint256 fullReceivableAmount) external {
        if (msg.sender != address(escrow)) revert NotEscrow();

        uint256 advanceAmount = advances[milestoneId];
        address client = advanceClient[milestoneId];
        address freelancer = advanceFreelancer[milestoneId];
        if (advanceAmount > outstanding) {
            outstanding = 0;
        } else {
            outstanding -= advanceAmount;
        }
        if (advanceAmount > outstandingByClient[client]) {
            outstandingByClient[client] = 0;
        } else {
            outstandingByClient[client] -= advanceAmount;
        }
        if (advanceAmount > outstandingByFreelancer[freelancer]) {
            outstandingByFreelancer[freelancer] = 0;
        } else {
            outstandingByFreelancer[freelancer] -= advanceAmount;
        }
        delete advances[milestoneId];
        delete advanceClient[milestoneId];
        delete advanceFreelancer[milestoneId];
        emit Repaid(milestoneId, fullReceivableAmount, advanceAmount);
    }

    function setReceivableRisk(
        uint256 milestoneId,
        uint8 riskTier,
        uint16 maxAdvanceBps,
        uint16 baseDiscountBps_,
        uint16 annualizedDiscountBps_,
        uint16 maxDiscountBps_,
        bytes32 riskHash
    ) external onlyOwner {
        (address freelancer, address client,, uint64 releaseAfter, uint8 status,,) = escrow.milestones(milestoneId);
        if (status != 3) revert NotApproved();
        if (client == freelancer) revert FraudFlag();
        if (riskTier > RISK_TIER_BLOCKED) revert CapExceeded();
        if (maxAdvanceBps > 10_000 || baseDiscountBps_ >= 10_000 || annualizedDiscountBps_ >= 10_000) {
            revert CapExceeded();
        }
        if (maxDiscountBps_ >= 10_000 || baseDiscountBps_ > maxDiscountBps_) revert CapExceeded();
        if (releaseAfter > block.timestamp && uint256(releaseAfter) - block.timestamp > maxReceivableTenor) {
            revert TenorTooLong();
        }
        if (riskTier == RISK_TIER_BLOCKED && maxAdvanceBps != 0) revert RiskBlocked();
        if (riskTier != RISK_TIER_BLOCKED && maxAdvanceBps == 0) revert InvalidAmount();

        riskPolicies[milestoneId] = RiskPolicy({
            published: true,
            riskTier: riskTier,
            maxAdvanceBps: maxAdvanceBps,
            baseDiscountBps: baseDiscountBps_,
            annualizedDiscountBps: annualizedDiscountBps_,
            maxDiscountBps: maxDiscountBps_,
            riskHash: riskHash
        });

        emit RiskPolicySet(
            milestoneId,
            riskTier,
            maxAdvanceBps,
            baseDiscountBps_,
            annualizedDiscountBps_,
            maxDiscountBps_,
            riskHash
        );
    }

    function setGuardrails(
        uint256 utilizationCapBps_,
        uint256 maxAdvance_,
        uint256 maxDiscountBps_,
        bool paused_
    ) external onlyOwner {
        if (utilizationCapBps_ > 10_000 || maxDiscountBps_ >= 10_000) revert CapExceeded();
        utilizationCapBps = utilizationCapBps_;
        maxAdvance = maxAdvance_;
        maxDiscountBps = maxDiscountBps_;
        paused = paused_;
        emit GuardrailsUpdated(utilizationCapBps_, maxAdvance_, maxDiscountBps_, paused_);
    }

    function setPricing(
        uint256 baseDiscountBps_,
        uint256 annualizedDiscountBps_,
        uint256 maxDiscountBps_
    ) external onlyOwner {
        if (baseDiscountBps_ >= 10_000 || annualizedDiscountBps_ >= 10_000 || maxDiscountBps_ >= 10_000) {
            revert CapExceeded();
        }
        if (baseDiscountBps_ > maxDiscountBps_) revert CapExceeded();

        baseDiscountBps = baseDiscountBps_;
        annualizedDiscountBps = annualizedDiscountBps_;
        maxDiscountBps = maxDiscountBps_;
        emit PricingUpdated(baseDiscountBps_, annualizedDiscountBps_, maxDiscountBps_);
    }

    function setRiskLimits(
        uint256 maxReceivableTenor_,
        uint256 clientExposureCap_,
        uint256 freelancerExposureCap_
    ) external onlyOwner {
        if (maxReceivableTenor_ == 0 || clientExposureCap_ == 0 || freelancerExposureCap_ == 0) {
            revert InvalidAmount();
        }
        maxReceivableTenor = maxReceivableTenor_;
        clientExposureCap = clientExposureCap_;
        freelancerExposureCap = freelancerExposureCap_;
        emit RiskLimitsUpdated(maxReceivableTenor_, clientExposureCap_, freelancerExposureCap_);
    }
}

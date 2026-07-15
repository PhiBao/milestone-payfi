// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IReceivablePool {
    function recordRepaymentFromEscrow(uint256 milestoneId, uint256 fullReceivableAmount) external;
}

contract MilestoneEscrow {
    enum Status {
        Draft,
        Funded,
        Submitted,
        Approved,
        EarlyPaid,
        Released,
        Cancelled
    }

    struct Milestone {
        address freelancer;
        address client;
        uint256 amount;
        uint64 releaseAfter;
        Status status;
        address repaymentTarget;
        bytes32 metadataHash;
    }

    IERC20Like public immutable usdc;
    address public owner;
    address public receivablePool;
    uint256 public nextMilestoneId = 1;
    uint64 public cancelGracePeriod = 7 days;
    mapping(uint256 => Milestone) public milestones;

    event ReceivablePoolSet(address indexed receivablePool);
    event MilestoneCreated(
        uint256 indexed milestoneId,
        address indexed freelancer,
        address indexed client,
        uint256 amount,
        uint64 releaseAfter,
        bytes32 metadataHash
    );
    event Funded(uint256 indexed milestoneId, address indexed client);
    event Submitted(uint256 indexed milestoneId, address indexed freelancer);
    event Approved(uint256 indexed milestoneId, address indexed client);
    event EarlyPayoutMarked(uint256 indexed milestoneId, address indexed pool);
    event Released(uint256 indexed milestoneId, address indexed recipient, uint256 amount, address indexed caller);
    event Cancelled(uint256 indexed milestoneId);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidStatus();
    error NotClient();
    error NotFreelancer();
    error NotOwner();
    error NotParticipant();
    error NotReceivablePool();
    error NotSettlementCaller();
    error ReleaseTooEarly();
    error CancelTooEarly();
    error TransferFailed();

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert InvalidAddress();
        usdc = IERC20Like(usdc_);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setReceivablePool(address receivablePool_) external onlyOwner {
        if (receivablePool_ == address(0)) revert InvalidAddress();
        receivablePool = receivablePool_;
        emit ReceivablePoolSet(receivablePool_);
    }

    function setCancelGracePeriod(uint64 cancelGracePeriod_) external onlyOwner {
        cancelGracePeriod = cancelGracePeriod_;
    }

    function createMilestone(
        address freelancer,
        address client,
        uint256 amount,
        uint64 releaseAfter,
        bytes32 metadataHash
    ) external returns (uint256 milestoneId) {
        if (freelancer == address(0) || client == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (msg.sender != freelancer && msg.sender != client) revert NotParticipant();

        milestoneId = nextMilestoneId++;
        milestones[milestoneId] = Milestone({
            freelancer: freelancer,
            client: client,
            amount: amount,
            releaseAfter: releaseAfter,
            status: Status.Draft,
            repaymentTarget: address(0),
            metadataHash: metadataHash
        });

        emit MilestoneCreated(milestoneId, freelancer, client, amount, releaseAfter, metadataHash);
    }

    function fund(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (msg.sender != milestone.client) revert NotClient();
        if (milestone.status != Status.Draft) revert InvalidStatus();

        milestone.status = Status.Funded;
        if (!usdc.transferFrom(msg.sender, address(this), milestone.amount)) revert TransferFailed();
        emit Funded(milestoneId, msg.sender);
    }

    function submit(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (msg.sender != milestone.freelancer) revert NotFreelancer();
        if (milestone.status != Status.Funded) revert InvalidStatus();

        milestone.status = Status.Submitted;
        emit Submitted(milestoneId, msg.sender);
    }

    function approve(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (msg.sender != milestone.client) revert NotClient();
        if (milestone.status != Status.Submitted) revert InvalidStatus();

        milestone.status = Status.Approved;
        emit Approved(milestoneId, msg.sender);
    }

    function markEarlyPaid(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (msg.sender != receivablePool) revert NotReceivablePool();
        if (milestone.status != Status.Approved) revert InvalidStatus();

        milestone.status = Status.EarlyPaid;
        milestone.repaymentTarget = msg.sender;
        emit EarlyPayoutMarked(milestoneId, msg.sender);
    }

    function release(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (
            msg.sender != milestone.client &&
            msg.sender != milestone.freelancer &&
            msg.sender != milestone.repaymentTarget
        ) {
            revert NotSettlementCaller();
        }
        if (block.timestamp < milestone.releaseAfter) revert ReleaseTooEarly();
        if (milestone.status != Status.Approved && milestone.status != Status.EarlyPaid) revert InvalidStatus();

        bool earlyPaid = milestone.status == Status.EarlyPaid;
        address recipient = earlyPaid ? milestone.repaymentTarget : milestone.freelancer;
        uint256 amount = milestone.amount;
        milestone.status = Status.Released;

        if (!usdc.transfer(recipient, amount)) revert TransferFailed();
        if (earlyPaid) {
            IReceivablePool(recipient).recordRepaymentFromEscrow(milestoneId, amount);
        }
        emit Released(milestoneId, recipient, amount, msg.sender);
    }

    function cancelUnfunded(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (msg.sender != milestone.freelancer && msg.sender != milestone.client) revert NotParticipant();
        if (milestone.status != Status.Draft) revert InvalidStatus();

        milestone.status = Status.Cancelled;
        emit Cancelled(milestoneId);
    }

    function cancelExpiredUnsubmitted(uint256 milestoneId) external {
        Milestone storage milestone = milestones[milestoneId];
        if (msg.sender != milestone.client) revert NotClient();
        if (milestone.status != Status.Funded) revert InvalidStatus();
        if (block.timestamp < uint256(milestone.releaseAfter) + cancelGracePeriod) revert CancelTooEarly();

        milestone.status = Status.Cancelled;
        if (!usdc.transfer(milestone.client, milestone.amount)) revert TransferFailed();
        emit Cancelled(milestoneId);
    }
}

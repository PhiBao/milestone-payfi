// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneEscrow} from "../contracts/MilestoneEscrow.sol";
import {ReceivablePool} from "../contracts/ReceivablePool.sol";

/// Minimal cheatcode interface (avoids the forge-std dependency).
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

/// Minimal 6-decimal ERC-20 mock matching the USDC surface the contracts use.
contract MockUsdc {
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract PayFiTest {
    MockUsdc internal usdc;
    MilestoneEscrow internal escrow;
    ReceivablePool internal pool;

    address internal owner = address(this);
    address internal client = address(0xC1);
    address internal freelancer = address(0xF1);
    address internal lp = address(0xB1);
    address internal agent = address(0xA1);
    address internal stranger = address(0x51);

    uint256 internal constant POOL_SEED = 10_000e6;
    uint256 internal constant AMOUNT = 1_000e6;
    uint256 internal constant TENOR = 10 days;

    uint256 internal milestoneId;

    // --- minimal assertions (no forge-std dependency) ----------------------
    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint256) failed");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address) failed");
    }

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function setUp() public {
        usdc = new MockUsdc();
        escrow = new MilestoneEscrow(address(usdc));
        pool = new ReceivablePool(address(usdc), address(escrow));
        escrow.setReceivablePool(address(pool));

        usdc.mint(client, 50_000e6);
        usdc.mint(lp, 50_000e6);

        vm.startPrank(lp);
        usdc.approve(address(pool), POOL_SEED);
        pool.deposit(POOL_SEED);
        vm.stopPrank();
    }

    // --- helpers -----------------------------------------------------------

    function _createFundedApproved() internal returns (uint256 id) {
        uint64 releaseAfter = uint64(block.timestamp + TENOR);
        vm.prank(client);
        id = escrow.createMilestone(freelancer, client, AMOUNT, releaseAfter, bytes32(uint256(1)));
        vm.startPrank(client);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fund(id);
        vm.stopPrank();
        vm.prank(freelancer);
        escrow.submit(id);
        vm.prank(client);
        escrow.approve(id);
    }

    function _publishTierA(uint256 id) internal {
        pool.setReceivableRisk(id, 0, 9800, 80, 2400, 600, bytes32(uint256(7)));
    }

    // --- core flow ---------------------------------------------------------

    function testFullAgentFlow() public {
        milestoneId = _createFundedApproved();

        // Owner delegates underwriting to the agent.
        pool.setUnderwriter(agent);
        assertEq(pool.underwriter(), agent);

        // Agent publishes the risk policy autonomously.
        vm.prank(agent);
        _publishTierA(milestoneId);
        (bool published, uint8 tier, , , , , ) = pool.riskPolicies(milestoneId);
        assertTrue(published);
        assertEq(tier, 0);

        // Freelancer draws the advance: 10-day tenor -> 80 + 65 = 145 bps
        // discount, capped by the 9800 bps policy max -> exactly 980 USDC.
        uint256 expectedAdvance = (AMOUNT * 9800) / 10_000;
        vm.prank(freelancer);
        pool.requestAdvance(milestoneId);
        assertEq(usdc.balanceOf(freelancer), expectedAdvance);
        assertEq(pool.outstanding(), expectedAdvance);

        // After the release time, anyone (settler agent) repays the pool.
        vm.warp(block.timestamp + TENOR + 1);
        vm.prank(stranger);
        pool.releaseReceivable(milestoneId);
        assertEq(usdc.balanceOf(address(pool)), POOL_SEED + AMOUNT - expectedAdvance);
        assertEq(pool.outstanding(), 0);
        assertEq(pool.outstandingByClient(client), 0);
        assertEq(pool.outstandingByFreelancer(freelancer), 0);
    }

    // --- underwriter access control ---------------------------------------

    function testOwnerCanPublishWithoutDelegation() public {
        milestoneId = _createFundedApproved();
        _publishTierA(milestoneId);
        (bool published, , , , , , ) = pool.riskPolicies(milestoneId);
        assertTrue(published);
    }

    function testStrangerCannotPublish() public {
        milestoneId = _createFundedApproved();
        vm.prank(stranger);
        vm.expectRevert(ReceivablePool.NotRiskPublisher.selector);
        pool.setReceivableRisk(milestoneId, 0, 9800, 80, 2400, 600, bytes32(0));
    }

    function testRevokedUnderwriterCannotPublish() public {
        milestoneId = _createFundedApproved();
        pool.setUnderwriter(agent);
        pool.setUnderwriter(address(0));
        vm.prank(agent);
        vm.expectRevert(ReceivablePool.NotRiskPublisher.selector);
        pool.setReceivableRisk(milestoneId, 0, 9800, 80, 2400, 600, bytes32(0));
    }

    function testOnlyOwnerCanDelegate() public {
        vm.prank(stranger);
        vm.expectRevert(ReceivablePool.NotOwner.selector);
        pool.setUnderwriter(agent);
    }

    // --- risk guardrails ---------------------------------------------------

    function testAdvanceWithoutPolicyReverts() public {
        milestoneId = _createFundedApproved();
        vm.prank(freelancer);
        vm.expectRevert(ReceivablePool.RiskPolicyMissing.selector);
        pool.requestAdvance(milestoneId);
    }

    function testPublishBeforeApprovalReverts() public {
        uint64 releaseAfter = uint64(block.timestamp + TENOR);
        vm.prank(client);
        uint256 id = escrow.createMilestone(freelancer, client, AMOUNT, releaseAfter, bytes32(uint256(1)));
        vm.expectRevert(ReceivablePool.NotApproved.selector);
        pool.setReceivableRisk(id, 0, 9800, 80, 2400, 600, bytes32(0));
    }

    function testSameWalletReceivableBlocked() public {
        uint64 releaseAfter = uint64(block.timestamp + TENOR);
        vm.prank(client);
        uint256 id = escrow.createMilestone(client, client, AMOUNT, releaseAfter, bytes32(uint256(2)));
        vm.startPrank(client);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fund(id);
        escrow.submit(id);
        escrow.approve(id);
        vm.stopPrank();

        vm.expectRevert(ReceivablePool.FraudFlag.selector);
        pool.setReceivableRisk(id, 0, 9800, 80, 2400, 600, bytes32(0));
    }

    function testExposureCapBlocksAdvance() public {
        milestoneId = _createFundedApproved();
        _publishTierA(milestoneId);
        pool.setRiskLimits(45 days, 100e6, 100e6);
        vm.prank(freelancer);
        vm.expectRevert(ReceivablePool.ExposureExceeded.selector);
        pool.requestAdvance(milestoneId);
    }

    function testTenorCapBlocksLongReceivable() public {
        uint64 releaseAfter = uint64(block.timestamp + 60 days);
        vm.prank(client);
        uint256 id = escrow.createMilestone(freelancer, client, AMOUNT, releaseAfter, bytes32(uint256(3)));
        vm.startPrank(client);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fund(id);
        vm.stopPrank();
        vm.prank(freelancer);
        escrow.submit(id);
        vm.prank(client);
        escrow.approve(id);

        vm.expectRevert(ReceivablePool.TenorTooLong.selector);
        pool.setReceivableRisk(id, 0, 9800, 80, 2400, 600, bytes32(0));
    }

    // --- escrow invariants -------------------------------------------------

    function testReleaseTooEarlyReverts() public {
        milestoneId = _createFundedApproved();
        vm.prank(client);
        vm.expectRevert(MilestoneEscrow.ReleaseTooEarly.selector);
        escrow.release(milestoneId);
    }

    function testEscrowPaysFreelancerDirectlyWithoutAdvance() public {
        milestoneId = _createFundedApproved();
        vm.warp(block.timestamp + TENOR + 1);
        vm.prank(client);
        escrow.release(milestoneId);
        assertEq(usdc.balanceOf(freelancer), AMOUNT);
        assertEq(usdc.balanceOf(address(pool)), POOL_SEED);
    }

    // --- LP accounting -----------------------------------------------------

    function testLpDepositWithdrawRoundTrip() public {
        (bool ok, ) = address(lp).call("");
        ok;
        vm.startPrank(lp);
        uint256 shares = pool.sharesOf(lp);
        pool.withdraw(shares / 2);
        vm.stopPrank();
        assertEq(usdc.balanceOf(lp), 40_000e6 + POOL_SEED / 2);
    }
}

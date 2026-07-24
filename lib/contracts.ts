import { parseAbi } from "viem";
import type { Address } from "./payfi-types";

export const USDC_DECIMALS = 6;

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
]);

export const milestoneEscrowAbi = parseAbi([
  "event MilestoneCreated(uint256 indexed milestoneId, address indexed freelancer, address indexed client, uint256 amount, uint64 releaseAfter, bytes32 metadataHash)",
  "event Funded(uint256 indexed milestoneId, address indexed client)",
  "event Submitted(uint256 indexed milestoneId, address indexed freelancer)",
  "event Approved(uint256 indexed milestoneId, address indexed client)",
  "event EarlyPayoutMarked(uint256 indexed milestoneId, address indexed pool)",
  "event Released(uint256 indexed milestoneId, address indexed recipient, uint256 amount)",
  "event Released(uint256 indexed milestoneId, address indexed recipient, uint256 amount, address indexed caller)",
  "event Cancelled(uint256 indexed milestoneId)",
  "function createMilestone(address freelancer, address client, uint256 amount, uint64 releaseAfter, bytes32 metadataHash) external returns (uint256 milestoneId)",
  "function fund(uint256 milestoneId) external",
  "function submit(uint256 milestoneId) external",
  "function approve(uint256 milestoneId) external",
  "function release(uint256 milestoneId) external",
  "function cancelUnfunded(uint256 milestoneId) external",
  "function cancelExpiredUnsubmitted(uint256 milestoneId) external",
  "function nextMilestoneId() external view returns (uint256)",
  "function milestones(uint256 milestoneId) external view returns (address freelancer, address client, uint256 amount, uint64 releaseAfter, uint8 status, address repaymentTarget, bytes32 metadataHash)"
]);

export const receivablePoolAbi = parseAbi([
  "event Deposited(address indexed funder, uint256 amount)",
  "event Deposited(address indexed funder, uint256 amount, uint256 shares)",
  "event Withdrawn(address indexed funder, uint256 amount, uint256 shares)",
  "event AdvanceIssued(uint256 indexed milestoneId, address indexed freelancer, uint256 advanceAmount)",
  "event Repaid(uint256 indexed milestoneId, uint256 fullReceivableAmount, uint256 advanceAmount)",
  "event GuardrailsUpdated(uint256 utilizationCapBps, uint256 maxAdvance, uint256 discountBps, bool paused)",
  "event PricingUpdated(uint256 baseDiscountBps, uint256 annualizedDiscountBps, uint256 maxDiscountBps)",
  "event RiskLimitsUpdated(uint256 maxReceivableTenor, uint256 clientExposureCap, uint256 freelancerExposureCap)",
  "event UnderwriterUpdated(address indexed underwriter)",
  "event RiskPolicySet(uint256 indexed milestoneId, uint8 riskTier, uint16 maxAdvanceBps, uint16 baseDiscountBps, uint16 annualizedDiscountBps, uint16 maxDiscountBps, bytes32 riskHash)",
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 shares) external",
  "function requestAdvance(uint256 milestoneId) external",
  "function releaseReceivable(uint256 milestoneId) external",
  "function setReceivableRisk(uint256 milestoneId, uint8 riskTier, uint16 maxAdvanceBps, uint16 baseDiscountBps, uint16 annualizedDiscountBps, uint16 maxDiscountBps, bytes32 riskHash) external",
  "function setUnderwriter(address underwriter) external",
  "function setRiskLimits(uint256 maxReceivableTenor, uint256 clientExposureCap, uint256 freelancerExposureCap) external",
  "function quoteAdvance(uint256 milestoneId) external view returns (uint256)",
  "function quoteDiscountBps(uint256 milestoneId) external view returns (uint256)",
  "function availableLiquidity() external view returns (uint256)",
  "function totalPoolValue() external view returns (uint256)",
  "function outstanding() external view returns (uint256)",
  "function outstandingByClient(address client) external view returns (uint256)",
  "function outstandingByFreelancer(address freelancer) external view returns (uint256)",
  "function owner() external view returns (address)",
  "function underwriter() external view returns (address)",
  "function sharesOf(address owner) external view returns (uint256)",
  "function totalShares() external view returns (uint256)",
  "function maxReceivableTenor() external view returns (uint256)",
  "function clientExposureCap() external view returns (uint256)",
  "function freelancerExposureCap() external view returns (uint256)",
  "function utilizationCapBps() external view returns (uint256)",
  "function maxAdvance() external view returns (uint256)",
  "function discountBps() external view returns (uint256)",
  "function baseDiscountBps() external view returns (uint256)",
  "function annualizedDiscountBps() external view returns (uint256)",
  "function maxDiscountBps() external view returns (uint256)",
  "function riskPolicies(uint256 milestoneId) external view returns (bool published, uint8 riskTier, uint16 maxAdvanceBps, uint16 baseDiscountBps, uint16 annualizedDiscountBps, uint16 maxDiscountBps, bytes32 riskHash)",
  "function paused() external view returns (bool)"
]);

export interface DeploymentConfig {
  chainId: number;
  usdc?: Address;
  escrow?: Address;
  pool?: Address;
  underwriter?: Address;
}

export const deployment: DeploymentConfig = {
  chainId: Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5_042_002),
  usdc: process.env.NEXT_PUBLIC_USDC_ADDRESS as Address | undefined,
  escrow: process.env.NEXT_PUBLIC_ESCROW_ADDRESS as Address | undefined,
  pool: process.env.NEXT_PUBLIC_POOL_ADDRESS as Address | undefined,
  underwriter: process.env.NEXT_PUBLIC_UNDERWRITER_ADDRESS as Address | undefined
};

export function contractsConfigured() {
  return Boolean(deployment.usdc && deployment.escrow && deployment.pool);
}

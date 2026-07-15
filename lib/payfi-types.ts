export type Address = `0x${string}`;
export type HexString = `0x${string}`;

export type Role = "client" | "freelancer";
export type RiskTier = "A" | "B" | "C" | "Blocked";

export type MilestoneStatus =
  | "draft"
  | "created_onchain"
  | "funded"
  | "submitted"
  | "approved"
  | "early_paid"
  | "released"
  | "cancelled";

export type ReceiptType =
  | "task_created"
  | "onchain_created"
  | "client_funded"
  | "work_submitted"
  | "client_approved"
  | "risk_reviewed"
  | "early_payout_taken"
  | "scheduled_release"
  | "cancelled";

export interface Receipt {
  id: string;
  type: ReceiptType;
  label: string;
  actorAddress: Address;
  createdAt: string;
  txHash?: HexString;
}

export interface Milestone {
  id: string;
  onchainId?: string;
  title: string;
  deliverable: string;
  amountUsdc: string;
  releaseAt: string;
  metadataHash: HexString;
  status: MilestoneStatus;
  submissionNote?: string;
  submissionUrl?: string;
  advanceUsdc?: string;
  riskReview?: RiskReview;
  txHash?: HexString;
}

export interface RiskReview {
  score: number;
  tier: RiskTier;
  flags: string[];
  hardBlock: boolean;
  maxAdvanceBps: number;
  baseDiscountBps: number;
  annualizedDiscountBps: number;
  maxDiscountBps: number;
  riskHash: HexString;
  reviewedAt: string;
}

export interface WorkContract {
  id: string;
  title: string;
  summary: string;
  clientName: string;
  clientEmail: string;
  clientAddress: Address;
  freelancerName: string;
  freelancerEmail: string;
  freelancerAddress: Address;
  creatorRole: Role;
  createdAt: string;
  chainId: number;
  escrowAddress?: Address;
  poolAddress?: Address;
  milestones: Milestone[];
  receipts: Receipt[];
}

export interface PoolSnapshot {
  totalPoolUsdc: string;
  availableUsdc: string;
  outstandingUsdc: string;
  utilizationCapBps: number;
  maxAdvanceUsdc: string;
  discountBps: number;
  paused: boolean;
}

export interface ContractListResponse {
  contracts: WorkContract[];
}

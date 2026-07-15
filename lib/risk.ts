import { metadataHash } from "./metadata";
import type { HexString, Milestone, RiskReview, RiskTier, WorkContract } from "./payfi-types";

export interface RiskInputs {
  availableUsdc?: string;
  outstandingUsdc?: string;
  maxAdvanceUsdc?: string;
  utilizationCapBps?: number;
  clientOutstandingUsdc?: string;
  freelancerOutstandingUsdc?: string;
  clientExposureCapUsdc?: string;
  freelancerExposureCapUsdc?: string;
}

const tierTerms: Record<RiskTier, Omit<RiskReview, "score" | "tier" | "flags" | "hardBlock" | "riskHash" | "reviewedAt">> = {
  A: {
    maxAdvanceBps: 9800,
    baseDiscountBps: 80,
    annualizedDiscountBps: 2400,
    maxDiscountBps: 600
  },
  B: {
    maxAdvanceBps: 9000,
    baseDiscountBps: 150,
    annualizedDiscountBps: 3600,
    maxDiscountBps: 900
  },
  C: {
    maxAdvanceBps: 7000,
    baseDiscountBps: 300,
    annualizedDiscountBps: 6000,
    maxDiscountBps: 1500
  },
  Blocked: {
    maxAdvanceBps: 0,
    baseDiscountBps: 0,
    annualizedDiscountBps: 0,
    maxDiscountBps: 0
  }
};

function numberValue(value?: string) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function tierForScore(score: number): RiskTier {
  if (score >= 60) return "Blocked";
  if (score >= 40) return "C";
  if (score >= 20) return "B";
  return "A";
}

export function buildRiskReview(contract: WorkContract, milestone: Milestone, inputs: RiskInputs = {}): RiskReview {
  const flags: string[] = [];
  let score = 0;
  const amount = numberValue(milestone.amountUsdc);
  const available = numberValue(inputs.availableUsdc);
  const outstanding = numberValue(inputs.outstandingUsdc);
  const maxAdvance = numberValue(inputs.maxAdvanceUsdc);
  const clientOutstanding = numberValue(inputs.clientOutstandingUsdc);
  const freelancerOutstanding = numberValue(inputs.freelancerOutstandingUsdc);
  const clientExposureCap = numberValue(inputs.clientExposureCapUsdc);
  const freelancerExposureCap = numberValue(inputs.freelancerExposureCapUsdc);
  const releaseTime = new Date(milestone.releaseAt).getTime();
  const daysToRelease = Math.max(0, (releaseTime - Date.now()) / (24 * 60 * 60 * 1000));

  if (sameAddress(contract.clientAddress, contract.freelancerAddress)) {
    flags.push("Client and freelancer wallets match");
    score += 100;
  }
  if (!milestone.submissionNote && !milestone.submissionUrl) {
    flags.push("No work evidence captured");
    score += 20;
  }
  if (daysToRelease > 45) {
    flags.push("Release tenor exceeds 45 days");
    score += 100;
  } else if (daysToRelease > 30) {
    flags.push("Long receivable tenor");
    score += 20;
  } else if (daysToRelease > 14) {
    flags.push("Medium receivable tenor");
    score += 10;
  }
  if (maxAdvance > 0 && amount > maxAdvance) {
    flags.push("Receivable amount exceeds pool max advance");
    score += 100;
  }
  if (available > 0 && amount > available) {
    flags.push("Receivable amount exceeds available pool liquidity");
    score += 40;
  }
  if (available + outstanding > 0) {
    const utilizationAfter = ((outstanding + amount) / (available + outstanding)) * 10_000;
    if (inputs.utilizationCapBps && utilizationAfter > inputs.utilizationCapBps) {
      flags.push("Advance would exceed utilization cap");
      score += 100;
    } else if (utilizationAfter > 5000) {
      flags.push("High post-advance utilization");
      score += 20;
    }
  }
  if (clientExposureCap > 0 && clientOutstanding + amount > clientExposureCap) {
    flags.push("Client exposure cap would be exceeded");
    score += 100;
  }
  if (freelancerExposureCap > 0 && freelancerOutstanding + amount > freelancerExposureCap) {
    flags.push("Freelancer exposure cap would be exceeded");
    score += 100;
  }

  score = Math.min(100, score);
  const tier = tierForScore(score);
  const terms = tierTerms[tier];
  const hardBlock = tier === "Blocked";
  const reviewedAt = new Date().toISOString();
  const reviewWithoutHash = {
    score,
    tier,
    flags,
    hardBlock,
    ...terms,
    reviewedAt,
    milestoneId: milestone.onchainId,
    amountUsdc: milestone.amountUsdc,
    releaseAt: milestone.releaseAt,
    clientAddress: contract.clientAddress,
    freelancerAddress: contract.freelancerAddress
  };

  return {
    score,
    tier,
    flags,
    hardBlock,
    ...terms,
    reviewedAt,
    riskHash: metadataHash(reviewWithoutHash) as HexString
  };
}

export function riskTierIndex(tier: RiskTier) {
  if (tier === "A") return 0;
  if (tier === "B") return 1;
  if (tier === "C") return 2;
  return 3;
}

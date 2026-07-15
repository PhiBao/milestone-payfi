import {
  createPublicClient,
  decodeEventLog,
  http,
  parseUnits,
  type Hex
} from "viem";
import { arcTestnet } from "./arc";
import { deployment, milestoneEscrowAbi, receivablePoolAbi, USDC_DECIMALS } from "./contracts";
import type { Milestone, WorkContract } from "./payfi-types";
import type { RiskReview } from "./payfi-types";

type EventPayload = {
  action: string;
  actorAddress: string;
  txHash?: Hex;
  onchainId?: string;
  advanceUsdc?: string;
  riskReview?: RiskReview;
};

const statusByAction: Record<string, number> = {
  onchain_created: 0,
  client_funded: 1,
  work_submitted: 2,
  client_approved: 3,
  risk_reviewed: 3,
  early_payout_taken: 4,
  scheduled_release: 5,
  cancelled: 6
};

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(arcTestnet.rpcUrls.default.http[0])
});

function sameAddress(a?: string, b?: string) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function findEvent(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[],
  address: string,
  abi: readonly unknown[],
  eventName: string
) {
  for (const log of logs) {
    if (!sameAddress(log.address, address)) continue;
    try {
      if (log.topics.length === 0) continue;
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]]
      });
      if (decoded.eventName === eventName) return decoded.args as Record<string, unknown>;
    } catch {
      // Ignore unrelated or overloaded logs.
    }
  }
  return null;
}

async function readMilestone(onchainId: string) {
  if (!deployment.escrow) throw new Error("Escrow address is not configured.");
  return publicClient.readContract({
    address: deployment.escrow,
    abi: milestoneEscrowAbi,
    functionName: "milestones",
    args: [BigInt(onchainId)]
  });
}

function expectedOnchainId(payload: EventPayload, milestone: Milestone) {
  const onchainId = payload.onchainId ?? milestone.onchainId;
  if (!onchainId) throw new Error("Onchain milestone id is required for chain verification.");
  return onchainId;
}

export async function verifyEventOnchain(args: {
  contract: WorkContract;
  milestone: Milestone;
  payload: EventPayload;
}) {
  const { contract, milestone, payload } = args;

  if (!deployment.escrow || !deployment.pool) {
    throw new Error("Contract addresses are not configured for chain verification.");
  }
  if (!payload.txHash) throw new Error("Transaction hash is required for chain verification.");

  const receipt = await publicClient.getTransactionReceipt({ hash: payload.txHash });
  if (receipt.status !== "success") throw new Error("Transaction did not succeed on Arc.");
  if (!sameAddress(receipt.from, payload.actorAddress)) {
    throw new Error("Transaction sender does not match the submitted actor address.");
  }

  if (payload.action === "onchain_created") {
    const event = findEvent(receipt.logs, deployment.escrow, milestoneEscrowAbi, "MilestoneCreated");
    if (!event) throw new Error("MilestoneCreated event was not found in the transaction receipt.");
    if (event.milestoneId?.toString() !== payload.onchainId) {
      throw new Error("Created milestone id does not match the receipt.");
    }
    if (!sameAddress(event.freelancer as string, contract.freelancerAddress)) {
      throw new Error("Created freelancer address does not match the task room.");
    }
    if (!sameAddress(event.client as string, contract.clientAddress)) {
      throw new Error("Created client address does not match the task room.");
    }
    if (event.amount !== parseUnits(milestone.amountUsdc, USDC_DECIMALS)) {
      throw new Error("Created receivable amount does not match the task room.");
    }
    if ((event.metadataHash as string)?.toLowerCase() !== milestone.metadataHash.toLowerCase()) {
      throw new Error("Created metadata hash does not match the task room.");
    }
    return;
  }

  const onchainId = expectedOnchainId(payload, milestone);
  const expectedMilestoneId = BigInt(onchainId);

  const expectedEventByAction: Record<string, { address: string; abi: readonly unknown[]; name: string }> = {
    client_funded: { address: deployment.escrow, abi: milestoneEscrowAbi, name: "Funded" },
    work_submitted: { address: deployment.escrow, abi: milestoneEscrowAbi, name: "Submitted" },
    client_approved: { address: deployment.escrow, abi: milestoneEscrowAbi, name: "Approved" },
    risk_reviewed: { address: deployment.pool, abi: receivablePoolAbi, name: "RiskPolicySet" },
    early_payout_taken: { address: deployment.pool, abi: receivablePoolAbi, name: "AdvanceIssued" },
    scheduled_release: { address: deployment.escrow, abi: milestoneEscrowAbi, name: "Released" },
    cancelled: { address: deployment.escrow, abi: milestoneEscrowAbi, name: "Cancelled" }
  };

  const expectedEvent = expectedEventByAction[payload.action];
  if (!expectedEvent) throw new Error("Unsupported onchain action.");

  const event = findEvent(receipt.logs, expectedEvent.address, expectedEvent.abi, expectedEvent.name);
  if (!event) throw new Error(`${expectedEvent.name} event was not found in the transaction receipt.`);
  if (event.milestoneId !== expectedMilestoneId) {
    throw new Error(`${expectedEvent.name} milestone id does not match the task room.`);
  }

  if (payload.action === "client_funded" && !sameAddress(event.client as string, contract.clientAddress)) {
    throw new Error("Funded event client does not match the task room.");
  }
  if (payload.action === "work_submitted" && !sameAddress(event.freelancer as string, contract.freelancerAddress)) {
    throw new Error("Submitted event freelancer does not match the task room.");
  }
  if (payload.action === "client_approved" && !sameAddress(event.client as string, contract.clientAddress)) {
    throw new Error("Approved event client does not match the task room.");
  }
  if (payload.action === "risk_reviewed") {
    if (!payload.riskReview) throw new Error("Risk review payload is required.");
    if (Number(event.riskTier) !== riskTierIndex(payload.riskReview.tier)) {
      throw new Error("Risk tier does not match the pool event.");
    }
    if (Number(event.maxAdvanceBps) !== payload.riskReview.maxAdvanceBps) {
      throw new Error("Risk max-advance policy does not match the pool event.");
    }
    if (Number(event.baseDiscountBps) !== payload.riskReview.baseDiscountBps) {
      throw new Error("Risk base discount does not match the pool event.");
    }
    if (Number(event.annualizedDiscountBps) !== payload.riskReview.annualizedDiscountBps) {
      throw new Error("Risk annualized discount does not match the pool event.");
    }
    if (Number(event.maxDiscountBps) !== payload.riskReview.maxDiscountBps) {
      throw new Error("Risk max discount does not match the pool event.");
    }
    if ((event.riskHash as string).toLowerCase() !== payload.riskReview.riskHash.toLowerCase()) {
      throw new Error("Risk hash does not match the pool event.");
    }
  }
  if (payload.action === "early_payout_taken") {
    if (!sameAddress(event.freelancer as string, contract.freelancerAddress)) {
      throw new Error("Advance event freelancer does not match the task room.");
    }
    if (payload.advanceUsdc) {
      const expectedAdvance = parseUnits(payload.advanceUsdc, USDC_DECIMALS);
      if (event.advanceAmount !== expectedAdvance) {
        throw new Error("Advance event amount does not match the submitted quote.");
      }
    }
  }
  if (payload.action === "scheduled_release") {
    const expectedRecipient = milestone.status === "early_paid" ? deployment.pool : contract.freelancerAddress;
    if (!sameAddress(event.recipient as string, expectedRecipient)) {
      throw new Error("Released event recipient does not match the expected settlement target.");
    }
  }

  const current = await readMilestone(onchainId);
  const [freelancer, client, amount, releaseAfter, status, , metadataHash] = current;
  if (!sameAddress(freelancer, contract.freelancerAddress)) throw new Error("Onchain freelancer does not match.");
  if (!sameAddress(client, contract.clientAddress)) throw new Error("Onchain client does not match.");
  if (amount !== parseUnits(milestone.amountUsdc, USDC_DECIMALS)) throw new Error("Onchain amount does not match.");
  if (Number(releaseAfter) !== Math.floor(new Date(milestone.releaseAt).getTime() / 1000)) {
    throw new Error("Onchain release time does not match.");
  }
  if ((metadataHash as string).toLowerCase() !== milestone.metadataHash.toLowerCase()) {
    throw new Error("Onchain metadata hash does not match.");
  }

  const expectedStatus = statusByAction[payload.action];
  if (expectedStatus !== undefined && Number(status) !== expectedStatus) {
    throw new Error(`Onchain milestone status is ${status}, expected ${expectedStatus}.`);
  }
}

function riskTierIndex(tier: RiskReview["tier"]) {
  switch (tier) {
    case "A":
      return 0;
    case "B":
      return 1;
    case "C":
      return 2;
    case "Blocked":
      return 3;
  }
}

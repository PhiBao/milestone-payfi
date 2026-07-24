import { formatUnits } from "viem";
import { milestoneEscrowAbi, receivablePoolAbi, USDC_DECIMALS } from "../lib/contracts";
import { buildRiskReview, riskTierIndex } from "../lib/risk";
import type { Milestone, WorkContract } from "../lib/payfi-types";
import { agentApiUrl, loadDeployment, log, makeClients, pollIntervalMs, readChain, runOnce, sleep, writeChain } from "./config";

/**
 * Underwriter agent.
 *
 * Watches Arc for milestones in the Approved state (funded receivables) that do
 * not have a published pool risk policy yet. For each one it:
 *   1. reads real onchain signals (pool liquidity, utilization, counterparty
 *      exposure, tenor, counterparty identity),
 *   2. scores the receivable with the same deterministic engine the UI uses,
 *   3. autonomously publishes the risk policy onchain from its own wallet
 *      (the pool owner delegates this via `setUnderwriter`),
 *   4. posts the decision back to the task room as a verified receipt.
 *
 * Run a single pass:   pnpm agent:underwrite -- --once
 * Run as a watcher:    pnpm agent:underwrite
 */

const AGENT = "underwriter";

interface RoomMatch {
  room: WorkContract;
  milestone: Milestone;
}

async function findRoom(onchainMetadataHash: string): Promise<RoomMatch | null> {
  try {
    const response = await fetch(`${agentApiUrl()}/api/contracts`);
    if (!response.ok) return null;
    const data = (await response.json()) as { contracts: WorkContract[] };
    for (const room of data.contracts) {
      const milestone = room.milestones.find(
        (item) => item.metadataHash.toLowerCase() === onchainMetadataHash.toLowerCase()
      );
      if (milestone) return { room, milestone };
    }
  } catch {
    // Room lookup is best-effort; onchain scoring does not depend on it.
  }
  return null;
}

async function postDecision(roomMatch: RoomMatch, actor: string, txHash: string, riskReview: unknown) {
  try {
    const response = await fetch(`${agentApiUrl()}/api/contracts/${roomMatch.room.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        milestoneId: roomMatch.milestone.id,
        action: "risk_reviewed",
        actorAddress: actor,
        txHash,
        riskReview
      })
    });
    if (!response.ok) {
      const body = await response.text();
      log(AGENT, "room decision receipt rejected", { status: response.status, body });
    }
  } catch (error) {
    log(AGENT, "room decision receipt failed", { error: String(error) });
  }
}

async function main() {
  const deployment = loadDeployment();
  const { account, publicClient, walletClient } = makeClients("UNDERWRITER_PRIVATE_KEY");
  log(AGENT, "agent online", { address: account.address, pool: deployment.pool });

  async function pass() {
    const nextId = await readChain<bigint>(publicClient, {
      address: deployment.escrow,
      abi: milestoneEscrowAbi,
      functionName: "nextMilestoneId"
    });

    for (let id = 1n; id < nextId; id++) {
      const milestoneData = await readChain<readonly [string, string, bigint, bigint, number, string, string]>(
        publicClient,
        {
          address: deployment.escrow,
          abi: milestoneEscrowAbi,
          functionName: "milestones",
          args: [id]
        }
      );
      const [freelancer, client, amount, releaseAfter, status, , metadataHash] = milestoneData;

      // Only Approved milestones (funded receivables) are underwritable.
      if (Number(status) !== 3) continue;

      const policy = await readChain<readonly [boolean, number, number, number, number, number, string]>(
        publicClient,
        {
          address: deployment.pool,
          abi: receivablePoolAbi,
          functionName: "riskPolicies",
          args: [id]
        }
      );
      if (policy[0]) continue; // Already published.

      // --- real onchain signals ------------------------------------------
      const signalReads = [
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "availableLiquidity" },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "outstanding" },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "maxAdvance" },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "utilizationCapBps" },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "outstandingByClient", args: [client] },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "outstandingByFreelancer", args: [freelancer] },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "clientExposureCap" },
        { address: deployment.pool, abi: receivablePoolAbi, functionName: "freelancerExposureCap" }
      ] as const;
      const signals: bigint[] = [];
      for (const params of signalReads) {
        signals.push(await readChain<bigint>(publicClient, params));
        await sleep(500);
      }
      const [
        availableLiquidity,
        outstanding,
        maxAdvance,
        utilizationCapBps,
        clientOutstanding,
        freelancerOutstanding,
        clientExposureCap,
        freelancerExposureCap
      ] = signals;

      // Best-effort room lookup: supplies offchain evidence signals and lets
      // the agent post its decision back as a verified receipt.
      const roomMatch = await findRoom(metadataHash as string);

      const contractShape = {
        clientAddress: client,
        freelancerAddress: freelancer
      } as WorkContract;
      const milestoneShape = {
        id: roomMatch?.milestone.id ?? `onchain_${id}`,
        onchainId: id.toString(),
        amountUsdc: formatUnits(amount, USDC_DECIMALS),
        releaseAt: new Date(Number(releaseAfter) * 1000).toISOString(),
        submissionNote: roomMatch?.milestone.submissionNote,
        submissionUrl: roomMatch?.milestone.submissionUrl
      } as Milestone;

      const review = buildRiskReview(contractShape, milestoneShape, {
        availableUsdc: formatUnits(availableLiquidity, USDC_DECIMALS),
        outstandingUsdc: formatUnits(outstanding, USDC_DECIMALS),
        maxAdvanceUsdc: formatUnits(maxAdvance, USDC_DECIMALS),
        utilizationCapBps: Number(utilizationCapBps),
        clientOutstandingUsdc: formatUnits(clientOutstanding, USDC_DECIMALS),
        freelancerOutstandingUsdc: formatUnits(freelancerOutstanding, USDC_DECIMALS),
        clientExposureCapUsdc: formatUnits(clientExposureCap, USDC_DECIMALS),
        freelancerExposureCapUsdc: formatUnits(freelancerExposureCap, USDC_DECIMALS)
      });

      log(AGENT, "scored receivable", {
        milestoneId: id.toString(),
        tier: review.tier,
        score: review.score,
        flags: review.flags
      });

      // --- autonomous onchain action --------------------------------------
      const hash = await writeChain(publicClient, walletClient, {
        address: deployment.pool,
        abi: receivablePoolAbi,
        functionName: "setReceivableRisk",
        args: [
          id,
          riskTierIndex(review.tier),
          review.maxAdvanceBps,
          review.baseDiscountBps,
          review.annualizedDiscountBps,
          review.maxDiscountBps,
          review.riskHash
        ]
      });

      log(AGENT, "published risk policy onchain", {
        milestoneId: id.toString(),
        tier: review.tier,
        maxAdvanceBps: review.maxAdvanceBps,
        txHash: hash
      });

      if (roomMatch) {
        await postDecision(roomMatch, account.address, hash, review);
      }
    }
  }

  if (runOnce()) {
    await pass();
    return;
  }

  for (;;) {
    try {
      await pass();
    } catch (error) {
      log(AGENT, "pass failed", { error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

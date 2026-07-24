import { milestoneEscrowAbi, receivablePoolAbi } from "../lib/contracts";
import type { WorkContract } from "../lib/payfi-types";
import { agentApiUrl, loadDeployment, log, makeClients, pollIntervalMs, readChain, runOnce, writeChain } from "./config";

/**
 * Settler agent.
 *
 * Watches Arc for milestones that reached their scheduled release time with an
 * outstanding pool advance (EarlyPaid). Settlement is permissionless through
 * `pool.releaseReceivable`, so the agent autonomously closes receivables and
 * repays the liquidity pool in USDC — no human in the loop.
 *
 * Run a single pass:   pnpm agent:settle -- --once
 * Run as a watcher:    pnpm agent:settle
 */

const AGENT = "settler";

async function findRoomId(onchainMetadataHash: string) {
  try {
    const response = await fetch(`${agentApiUrl()}/api/contracts`);
    if (!response.ok) return null;
    const data = (await response.json()) as { contracts: WorkContract[] };
    for (const room of data.contracts) {
      const milestone = room.milestones.find(
        (item) => item.metadataHash.toLowerCase() === onchainMetadataHash.toLowerCase()
      );
      if (milestone) return { roomId: room.id, milestoneId: milestone.id };
    }
  } catch {
    // Best-effort only.
  }
  return null;
}

async function postSettlement(room: { roomId: string; milestoneId: string }, actor: string, txHash: string) {
  try {
    const response = await fetch(`${agentApiUrl()}/api/contracts/${room.roomId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        milestoneId: room.milestoneId,
        action: "scheduled_release",
        actorAddress: actor,
        txHash
      })
    });
    if (!response.ok) {
      log(AGENT, "room settlement receipt rejected", { status: response.status });
    }
  } catch (error) {
    log(AGENT, "room settlement receipt failed", { error: String(error) });
  }
}

async function main() {
  const deployment = loadDeployment();
  const { account, publicClient, walletClient } = makeClients("SETTLER_PRIVATE_KEY");
  log(AGENT, "agent online", { address: account.address, pool: deployment.pool });

  async function pass() {
    const now = Math.floor(Date.now() / 1000);
    const nextId = await readChain<bigint>(publicClient, {
      address: deployment.escrow,
      abi: milestoneEscrowAbi,
      functionName: "nextMilestoneId"
    });

    for (let id = 1n; id < nextId; id++) {
      const [, , , releaseAfter, status, , metadataHash] = await readChain<
        readonly [string, string, bigint, bigint, number, string, string]
      >(publicClient, {
        address: deployment.escrow,
        abi: milestoneEscrowAbi,
        functionName: "milestones",
        args: [id]
      });

      // Only EarlyPaid milestones with a due release time: escrow then repays
      // the pool. Approved-but-never-advanced milestones settle directly
      // between the participants, not through the pool.
      if (Number(status) !== 4) continue;
      if (Number(releaseAfter) > now) continue;

      log(AGENT, "settling due receivable", { milestoneId: id.toString() });

      const hash = await writeChain(publicClient, walletClient, {
        address: deployment.pool,
        abi: receivablePoolAbi,
        functionName: "releaseReceivable",
        args: [id]
      });

      log(AGENT, "receivable settled, pool repaid", { milestoneId: id.toString(), txHash: hash });

      const room = await findRoomId(metadataHash as string);
      if (room) {
        await postSettlement(room, account.address, hash);
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

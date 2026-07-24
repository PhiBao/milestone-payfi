import { readFileSync, writeFileSync } from "node:fs";
import { keccak256, parseAbi, parseAbiItem, toHex } from "viem";
import { loadDeployment, log, makeClients } from "./config";

/**
 * ERC-8004 agent identity registration on Arc Testnet.
 *
 * Registers the underwriter agent's onchain identity (identity NFT), then
 * optionally records its first reputation attestation from a separate
 * validator wallet (ERC-8004 blocks self-feedback). The resulting agent id is
 * merged into deployments/arc-testnet.json.
 *
 * Registries (Arc Testnet, from https://docs.arc.network):
 *   Identity:   0x8004A818BFB912233c491871b3d84c89A494BD9e
 *   Reputation: 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *
 * Usage: pnpm agent:register
 * Env:   UNDERWRITER_PRIVATE_KEY (required), VALIDATOR_PRIVATE_KEY (optional),
 *        AGENT_METADATA_URI (optional, defaults to the Arc docs example)
 */

const AGENT = "agent-registry";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;

const identityAbi = parseAbi([
  "function register(string metadataURI) external",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenURI(uint256 tokenId) external view returns (string)"
]);

const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 score, uint8 decimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external"
]);

const DEFAULT_METADATA_URI = "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

async function main() {
  const deployment = loadDeployment();
  const { account, publicClient, walletClient } = makeClients("UNDERWRITER_PRIVATE_KEY");
  const metadataURI = process.env.AGENT_METADATA_URI || DEFAULT_METADATA_URI;

  log(AGENT, "registering agent identity", { owner: account.address, metadataURI });

  // Resume mode: reuse an already-sent registration tx (avoids double mints).
  let registerHash = process.env.AGENT_REGISTER_TX as `0x${string}` | undefined;
  if (!registerHash) {
    registerHash = await walletClient.writeContract({
      address: IDENTITY_REGISTRY,
      abi: identityAbi,
      functionName: "register",
      args: [metadataURI]
    });
  }
  const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  log(AGENT, "identity registered", { txHash: registerHash });

  // Resolve the agent id from the registration receipt itself (most reliable
  // path — public RPC nodes can lag on eth_getLogs), falling back to a log
  // scan if the layout ever changes.
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const mintLog = registerReceipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
      entry.topics[0] === transferTopic &&
      entry.topics.length >= 4
  );

  let agentId: bigint;
  if (mintLog) {
    agentId = BigInt(mintLog.topics[3]!);
  } else {
    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = latestBlock > 10_000n ? latestBlock - 10_000n : 0n;
    const transferLogs = await publicClient.getLogs({
      address: IDENTITY_REGISTRY,
      event: parseAbiItem(
        "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
      ),
      args: { to: account.address },
      fromBlock,
      toBlock: latestBlock
    });
    if (transferLogs.length === 0) {
      throw new Error("No Transfer events found — registration may have failed.");
    }
    agentId = transferLogs[transferLogs.length - 1].args.tokenId!;
  }
  log(AGENT, "agent id resolved", { agentId: agentId.toString() });

  // Optional: first reputation attestation from a separate validator wallet.
  let reputationTx: string | null = null;
  if (process.env.VALIDATOR_PRIVATE_KEY) {
    const validator = makeClients("VALIDATOR_PRIVATE_KEY");
    const tag = "risk_underwriting";
    reputationTx = await validator.walletClient.writeContract({
      address: REPUTATION_REGISTRY,
      abi: reputationAbi,
      functionName: "giveFeedback",
      args: [agentId, 95n, 0, tag, "", "", "", keccak256(toHex(tag))]
    });
    await publicClient.waitForTransactionReceipt({ hash: reputationTx as `0x${string}` });
    log(AGENT, "reputation recorded", { txHash: reputationTx, validator: validator.account.address });
  } else {
    log(AGENT, "VALIDATOR_PRIVATE_KEY not set; skipping reputation attestation");
  }

  const record = JSON.parse(readFileSync("deployments/arc-testnet.json", "utf8"));
  record.agentIdentity = {
    registry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
    agentId: agentId.toString(),
    owner: account.address,
    metadataURI,
    registerTxHash: registerHash,
    reputationTxHash: reputationTx,
    registeredAt: new Date().toISOString()
  };
  writeFileSync("deployments/arc-testnet.json", JSON.stringify(record, null, 2) + "\n");

  log(AGENT, "deployment record updated", {
    agentId: agentId.toString(),
    pool: deployment.pool,
    explorer: `https://testnet.arcscan.app/address/${account.address}`
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

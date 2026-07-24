import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "../lib/arc";

/**
 * Shared agent configuration: Arc clients + deployment addresses.
 * Addresses resolve from NEXT_PUBLIC_* env first, then deployments/arc-testnet.json.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The public Arc RPC rate-limits aggressively; retry reads with backoff. */
export async function readChain<T>(publicClient: PublicClient, params: object, attempts = 15): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return (await publicClient.readContract(params as Parameters<PublicClient["readContract"]>[0])) as T;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await sleep(4_000);
    }
  }
  throw new Error("read failed");
}

/** Rate-limit-resilient contract write: send, wait for receipt, pace next tx. */
export async function writeChain(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: object,
  attempts = 15
): Promise<Hex> {
  for (let i = 0; i < attempts; i++) {
    try {
      const hash = (await walletClient.writeContract(
        params as Parameters<WalletClient["writeContract"]>[0]
      )) as Hex;
      await sleep(3_000);
      for (let j = 0; j < 40; j++) {
        try {
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
          await sleep(1_500);
          return hash;
        } catch (error) {
          if (error instanceof Error && error.message.includes("reverted")) throw error;
          if (j === 39) throw error;
          await sleep(4_000);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("reverted")) throw error;
      if (i === attempts - 1) throw error;
      await sleep(6_000);
    }
  }
  throw new Error("write failed");
}

export interface AgentDeployment {
  usdc: Address;
  escrow: Address;
  pool: Address;
  underwriter?: Address | null;
}

export function rpcUrl() {
  return process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
}

export function loadDeployment(): AgentDeployment {
  let fromFile: Partial<AgentDeployment> = {};
  try {
    fromFile = JSON.parse(readFileSync("deployments/arc-testnet.json", "utf8"));
  } catch {
    // Env-only configuration is fine.
  }

  const usdc = (process.env.NEXT_PUBLIC_USDC_ADDRESS || fromFile.usdc) as Address | undefined;
  const escrow = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS || fromFile.escrow) as Address | undefined;
  const pool = (process.env.NEXT_PUBLIC_POOL_ADDRESS || fromFile.pool) as Address | undefined;

  if (!usdc || !escrow || !pool) {
    throw new Error("Missing deployment addresses: set NEXT_PUBLIC_* envs or deployments/arc-testnet.json.");
  }

  return { usdc, escrow, pool, underwriter: fromFile.underwriter ?? null };
}

export function makeClients(privateKeyEnv: string) {
  const raw = process.env[privateKeyEnv];
  if (!raw) throw new Error(`${privateKeyEnv} is required.`);
  const account = privateKeyToAccount(raw.startsWith("0x") ? (raw as Address) : (`0x${raw}` as Address));
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl()) });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl()) });
  return { account, publicClient, walletClient };
}

/** Room API for best-effort receipt/decision posting. */
export function agentApiUrl() {
  return (process.env.AGENT_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
}

export function pollIntervalMs() {
  return Math.max(3_000, Number(process.env.AGENT_POLL_INTERVAL_MS || 15_000));
}

export function runOnce() {
  return process.argv.includes("--once");
}

export function log(agent: string, message: string, extra?: Record<string, unknown>) {
  const line = { ts: new Date().toISOString(), agent, message, ...extra };
  console.log(JSON.stringify(line));
}

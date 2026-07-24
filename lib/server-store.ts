import { promises as fs } from "node:fs";
import path from "node:path";
import { makeId } from "./metadata";
import type { Address, HexString, MilestoneStatus, ReceiptType, RiskReview, WorkContract } from "./payfi-types";
import {
  pgCreateContract,
  pgGetContract,
  pgListContracts,
  pgMutateContract,
  postgresConfigured
} from "./server-store-pg";

/**
 * Dual-mode persistence:
 * - DATABASE_URL / POSTGRES_URL set  -> durable Postgres (production deploys)
 * - otherwise                        -> local .data/contracts.json (hackathon dev)
 */

const dataDir = path.join(process.cwd(), ".data");
const dataPath = path.join(dataDir, "contracts.json");

interface StoreShape {
  contracts: WorkContract[];
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(dataPath, "utf8");
    return JSON.parse(raw) as StoreShape;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
    return { contracts: [] };
  }
}

async function writeStore(store: StoreShape) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dataPath, JSON.stringify(store, null, 2));
}

async function fsListContracts() {
  const store = await readStore();
  return [...store.contracts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function fsGetContract(id: string) {
  const store = await readStore();
  return store.contracts.find((contract) => contract.id === id) ?? null;
}

async function fsCreateContract(contract: WorkContract) {
  const store = await readStore();
  store.contracts.unshift(contract);
  await writeStore(store);
  return contract;
}

async function fsMutateContract(
  id: string,
  updater: (contract: WorkContract) => WorkContract
) {
  const store = await readStore();
  const index = store.contracts.findIndex((contract) => contract.id === id);
  if (index < 0) return null;

  const updated = updater(store.contracts[index]);
  store.contracts[index] = updated;
  await writeStore(store);
  return updated;
}

export async function listContracts() {
  return postgresConfigured() ? pgListContracts() : fsListContracts();
}

export async function getContract(id: string) {
  return postgresConfigured() ? pgGetContract(id) : fsGetContract(id);
}

export async function createContract(contract: WorkContract) {
  return postgresConfigured() ? pgCreateContract(contract) : fsCreateContract(contract);
}

export async function mutateContract(
  id: string,
  updater: (contract: WorkContract) => WorkContract
) {
  return postgresConfigured() ? pgMutateContract(id, updater) : fsMutateContract(id, updater);
}

export function appendReceipt(args: {
  contract: WorkContract;
  type: ReceiptType;
  actorAddress: Address;
  label: string;
  txHash?: HexString;
}): WorkContract {
  return {
    ...args.contract,
    receipts: [
      {
        id: makeId("receipt"),
        type: args.type,
        actorAddress: args.actorAddress,
        label: args.label,
        txHash: args.txHash,
        createdAt: new Date().toISOString()
      },
      ...args.contract.receipts
    ]
  };
}

export function updateMilestoneStatus(args: {
  contract: WorkContract;
  milestoneId: string;
  status: MilestoneStatus;
  txHash?: HexString;
  onchainId?: string;
  submissionNote?: string;
  submissionUrl?: string;
  advanceUsdc?: string;
  riskReview?: RiskReview;
}) {
  return {
    ...args.contract,
    milestones: args.contract.milestones.map((milestone) =>
      milestone.id === args.milestoneId
        ? {
            ...milestone,
            status: args.status,
            txHash: args.txHash ?? milestone.txHash,
            onchainId: args.onchainId ?? milestone.onchainId,
            submissionNote: args.submissionNote ?? milestone.submissionNote,
            submissionUrl: args.submissionUrl ?? milestone.submissionUrl,
            advanceUsdc: args.advanceUsdc ?? milestone.advanceUsdc,
            riskReview: args.riskReview ?? milestone.riskReview
          }
        : milestone
    )
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { makeId } from "./metadata";
import type { Address, HexString, MilestoneStatus, ReceiptType, RiskReview, WorkContract } from "./payfi-types";

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

export async function listContracts() {
  const store = await readStore();
  return [...store.contracts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getContract(id: string) {
  const store = await readStore();
  return store.contracts.find((contract) => contract.id === id) ?? null;
}

export async function createContract(contract: WorkContract) {
  const store = await readStore();
  store.contracts.unshift(contract);
  await writeStore(store);
  return contract;
}

export async function mutateContract(
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

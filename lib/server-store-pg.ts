import { Pool } from "pg";
import type { WorkContract } from "./payfi-types";

/**
 * Postgres-backed store used when DATABASE_URL (or POSTGRES_URL) is set.
 * Each WorkContract is stored as a JSONB document keyed by id, mirroring the
 * shape of the local filesystem store so both backends stay interchangeable.
 */

let pool: Pool | null = null;
let tableReady: Promise<void> | null = null;

function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

export function postgresConfigured() {
  return Boolean(databaseUrl());
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: 4
    });
  }
  return pool;
}

async function ensureTable() {
  if (!tableReady) {
    tableReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS contracts (
          id text PRIMARY KEY,
          doc jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`
      )
      .then(() => undefined)
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  return tableReady;
}

export async function pgListContracts(): Promise<WorkContract[]> {
  await ensureTable();
  const result = await getPool().query<{ doc: WorkContract }>(
    "SELECT doc FROM contracts ORDER BY doc->>'createdAt' DESC"
  );
  return result.rows.map((row) => row.doc);
}

export async function pgGetContract(id: string): Promise<WorkContract | null> {
  await ensureTable();
  const result = await getPool().query<{ doc: WorkContract }>(
    "SELECT doc FROM contracts WHERE id = $1",
    [id]
  );
  return result.rows[0]?.doc ?? null;
}

export async function pgCreateContract(contract: WorkContract): Promise<WorkContract> {
  await ensureTable();
  await getPool().query("INSERT INTO contracts (id, doc) VALUES ($1, $2)", [
    contract.id,
    JSON.stringify(contract)
  ]);
  return contract;
}

export async function pgMutateContract(
  id: string,
  updater: (contract: WorkContract) => WorkContract
): Promise<WorkContract | null> {
  await ensureTable();
  const existing = await pgGetContract(id);
  if (!existing) return null;

  const updated = updater(existing);
  await getPool().query("UPDATE contracts SET doc = $2 WHERE id = $1", [
    id,
    JSON.stringify(updated)
  ]);
  return updated;
}

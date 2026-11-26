import pg, { type PoolClient, type QueryResultRow } from "pg";

import { pool } from "@/lib/db";

export type Db = Pick<PoolClient, "query">;

// numeric comes back from pg as a string; dates as JS Dates at local midnight.
// Return `date` columns as plain YYYY-MM-DD strings so no timezone sneaks in.
pg.types.setTypeParser(1082, (value: string) => value);

export async function rows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function one<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T | null> {
  return (await db.query<T>(sql, params)).rows[0] ?? null;
}

export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function logEvent(
  db: Db,
  ownerId: string | null,
  kind: string,
  summary: string,
  data: Record<string, unknown> = {},
) {
  await db.query("insert into events (owner_id, kind, summary, data) values ($1, $2, $3, $4)", [
    ownerId,
    kind,
    summary,
    JSON.stringify(data),
  ]);
}

export const toCents = (value: string | number | null) => Math.round(Number(value ?? 0) * 100);
export const fromCents = (cents: number) => (cents / 100).toFixed(2);

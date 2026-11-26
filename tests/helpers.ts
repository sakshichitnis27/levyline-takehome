import { readFileSync } from "node:fs";

import { pool } from "@/lib/db";
import { parseCsv } from "@/lib/import/normalize";
import { suggestMapping, type Decisions } from "@/lib/import/plan";

export async function resetDb() {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
  );
  await pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} cascade`);
}

export function csv(name: string) {
  return readFileSync(`data/${name}`, "utf8");
}

export function mappingFor(text: string) {
  return suggestMapping(parseCsv(text)[0]);
}

export const decisions = (overrides: Partial<Decisions> = {}): Decisions => ({
  dateOrder: "dmy",
  merges: {},
  archiveUnitIds: [],
  ...overrides,
});

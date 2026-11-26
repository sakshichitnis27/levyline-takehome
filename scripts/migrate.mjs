#!/usr/bin/env node
// Applies migrations/*.sql in filename order, once each.
//   npm run db:migrate
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

for (const file of [".env.local", ".env"]) {
  const raw = await readFile(file, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(
  "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
);
const { rows } = await client.query("select name from schema_migrations");
const applied = new Set(rows.map((r) => r.name));
const files = (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(path.join("migrations", file), "utf8");
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("insert into schema_migrations (name) values ($1)", [file]);
    await client.query("commit");
    console.log(`[migrate] applied ${file}`);
  } catch (error) {
    await client.query("rollback");
    console.error(`[migrate] ${file} failed: ${error.message}`);
    process.exit(1);
  }
}
await client.end();

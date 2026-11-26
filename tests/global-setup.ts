import { execSync } from "node:child_process";

// Integration tests run against their own database, rebuilt from the
// migrations each run: TEST_DATABASE_URL, default postgres://localhost/levyline_test.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost/levyline_test";
  const name = new URL(url).pathname.slice(1);
  execSync(`dropdb --if-exists ${name} && createdb ${name}`, { stdio: "inherit" });
  execSync("node scripts/migrate.mjs", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}

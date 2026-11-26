import { readFile } from "node:fs/promises";
import path from "node:path";

// Serves the two sample exports in data/ so they can be imported in one click.
const FILES: Record<string, string> = {
  first: "owners-and-receivables.csv",
  update: "owners-and-receivables-update.csv",
};

export async function GET(request: Request) {
  const name = FILES[new URL(request.url).searchParams.get("file") ?? ""];
  if (!name) return Response.json({ error: "Unknown sample" }, { status: 404 });
  const csv = await readFile(path.join(process.cwd(), "data", name), "utf8");
  return Response.json({ name, csv });
}

import { handle, body } from "@/lib/api";
import type { Decisions, Mapping } from "@/lib/import/plan";
import { commitImport } from "@/lib/import/run";

export const POST = handle(async (request: Request) => {
  const input = await body<{ csv: string; fileName: string; mapping: Mapping; decisions: Decisions }>(request);
  const { importId, plan } = await commitImport(input.fileName || "upload.csv", input.csv, input.mapping, input.decisions);
  return Response.json({ importId, counts: plan.counts });
});

import { handle, body } from "@/lib/api";
import { parseCsv } from "@/lib/import/normalize";
import { suggestMapping, type Decisions, type Mapping } from "@/lib/import/plan";
import { previewImport } from "@/lib/import/run";

export const POST = handle(async (request: Request) => {
  const input = await body<{ csv: string; mapping?: Mapping; decisions: Decisions }>(request);
  const table = parseCsv(input.csv);
  if (table.length < 2) return Response.json({ error: "The file has no rows" }, { status: 422 });
  const mapping = input.mapping ?? suggestMapping(table[0]);
  const plan = await previewImport(input.csv, mapping, input.decisions);
  return Response.json({ mapping, plan });
});

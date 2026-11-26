import { body, handle } from "@/lib/api";
import { STARTER_GRAPH } from "@/lib/automation/store";
import { one } from "@/lib/sql";

export const POST = handle(async (request: Request) => {
  const { name, clientId } = await body<{ name?: string; clientId?: string }>(request);
  const row = await one<{ id: string }>(
    "insert into automations (name, client_id, graph) values ($1, $2, $3) returning id",
    [name?.trim() || "New automation", clientId || null, JSON.stringify(STARTER_GRAPH)],
  );
  return Response.json({ id: row!.id });
});

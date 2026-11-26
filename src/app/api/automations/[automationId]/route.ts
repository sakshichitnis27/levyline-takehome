import { body, handle, HttpError } from "@/lib/api";
import type { Graph } from "@/lib/automation/graph";
import { getAutomation } from "@/lib/automation/store";
import { pool } from "@/lib/db";

// Saves the draft. Owners already in a live automation keep running the
// version they started on; "Turn on" publishes this draft for new owners.
export const PUT = handle(async (request: Request, { params }: { params: Promise<{ automationId: string }> }) => {
  const { automationId } = await params;
  const input = await body<{ name: string; clientId: string | null; graph: Graph }>(request);
  const a = await getAutomation(automationId);
  if (!a) throw new HttpError(404, "Automation not found");
  if (!Array.isArray(input.graph?.nodes) || !Array.isArray(input.graph?.edges)) throw new HttpError(422, "Invalid graph");
  await pool.query("update automations set name = $2, client_id = $3, graph = $4, updated_at = now() where id = $1", [
    automationId,
    input.name?.trim() || a.name,
    input.clientId || null,
    JSON.stringify(input.graph),
  ]);
  return Response.json({ ok: true });
});

export const DELETE = handle(async (_: Request, { params }: { params: Promise<{ automationId: string }> }) => {
  const { automationId } = await params;
  const running = await pool.query("select 1 from enrollments where automation_id = $1 limit 1", [automationId]);
  if (running.rowCount) throw new HttpError(409, "Owners have been through this automation; turn it off instead");
  await pool.query("delete from automations where id = $1", [automationId]);
  return Response.json({ ok: true });
});

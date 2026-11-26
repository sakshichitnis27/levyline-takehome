import { body, handle, HttpError } from "@/lib/api";
import { candidates, enroll, getAutomation } from "@/lib/automation/store";

export const GET = handle(async (_: Request, { params }: { params: Promise<{ automationId: string }> }) => {
  const { automationId } = await params;
  const a = await getAutomation(automationId);
  if (!a?.client_id) throw new HttpError(404, "Choose a client first");
  return Response.json({ owners: await candidates(a.client_id, automationId) });
});

export const POST = handle(async (request: Request, { params }: { params: Promise<{ automationId: string }> }) => {
  const { automationId } = await params;
  const { ownerIds } = await body<{ ownerIds: string[] }>(request);
  try {
    return Response.json({ results: await enroll(automationId, ownerIds ?? []) });
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  }
});

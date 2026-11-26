import { body, handle } from "@/lib/api";
import { setStatus } from "@/lib/automation/store";

export const POST = handle(async (request: Request, { params }: { params: Promise<{ automationId: string }> }) => {
  const { automationId } = await params;
  const { status } = await body<{ status: "live" | "paused" | "draft" }>(request);
  const result = await setStatus(automationId, status);
  return Response.json(result, { status: result.errors.length ? 422 : 200 });
});

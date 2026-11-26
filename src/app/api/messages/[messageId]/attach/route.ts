import { body, handle, HttpError } from "@/lib/api";
import { attachInbound } from "@/lib/messaging";
import { getOwner } from "@/lib/owners";

export const POST = handle(async (request: Request, { params }: { params: Promise<{ messageId: string }> }) => {
  const { messageId } = await params;
  const { ownerId } = await body<{ ownerId: string }>(request);
  if (!(await getOwner(ownerId))) throw new HttpError(404, "Owner not found");
  await attachInbound(messageId, ownerId);
  return Response.json({ ok: true });
});

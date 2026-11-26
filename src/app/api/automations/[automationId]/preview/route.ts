import { body, handle, HttpError } from "@/lib/api";
import { getAutomation } from "@/lib/automation/store";
import { now } from "@/lib/clock";
import { getOwner, ownerReceivables } from "@/lib/owners";
import { buildContext, render } from "@/lib/render";
import { chaseable } from "@/lib/rules";
import { irishDate } from "@/lib/time";

// Renders a Send email step with a real owner's data, as it would go out now.
export const POST = handle(async (request: Request, { params }: { params: Promise<{ automationId: string }> }) => {
  const { automationId } = await params;
  const input = await body<{ ownerId: string; subject: string; body: string }>(request);
  const a = await getAutomation(automationId);
  if (!a?.client_id) throw new HttpError(422, "Choose the automation's client first");
  const owner = await getOwner(input.ownerId);
  if (!owner) throw new HttpError(404, "Owner not found");
  const all = (await ownerReceivables(owner.id)).filter((r) => r.clientId === a.client_id);
  const chase = chaseable(all, irishDate(await now()));
  const ctx = buildContext({ ownerName: owner.full_name, clientName: a.client_name ?? "", receivables: chase });
  const subject = render(input.subject ?? "", ctx);
  const text = render(input.body ?? "", ctx);
  return Response.json({
    subject: subject.text,
    body: text.text,
    missing: [...new Set([...subject.missing, ...text.missing])],
    note: chase.length ? null : "Nothing of theirs could be chased right now, so this email wouldn't go out yet.",
  });
});

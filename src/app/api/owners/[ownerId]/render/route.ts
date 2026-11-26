import { handle, HttpError } from "@/lib/api";
import { getOwner, ownerReceivables } from "@/lib/owners";
import { buildContext, render } from "@/lib/render";
import { listTemplates } from "@/lib/templates";

// Fills a template with this owner's data, for staff to edit before sending.
export const GET = handle(async (request: Request, { params }: { params: Promise<{ ownerId: string }> }) => {
  const { ownerId } = await params;
  const url = new URL(request.url);
  const owner = await getOwner(ownerId);
  if (!owner) throw new HttpError(404, "Owner not found");
  const template = (await listTemplates()).find((t) => t.id === url.searchParams.get("template"));
  if (!template) throw new HttpError(404, "Template not found");
  const all = await ownerReceivables(ownerId);
  const clientId = url.searchParams.get("clientId") ?? all[0]?.clientId;
  const receivables = all.filter((r) => r.clientId === clientId && r.outstandingCents > 0);
  const ctx = buildContext({
    ownerName: owner.full_name,
    clientName: all.find((r) => r.clientId === clientId)?.clientName ?? "",
    receivables,
  });
  const subject = render(template.subject, ctx);
  const text = render(template.body, ctx);
  return Response.json({ subject: subject.text, body: text.text, missing: [...subject.missing, ...text.missing] });
});

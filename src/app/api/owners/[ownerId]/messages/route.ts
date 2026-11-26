import { body, handle, HttpError } from "@/lib/api";
import { pool } from "@/lib/db";
import { isUsableEmail } from "@/lib/import/plan";
import { deliverNow, queueMessage } from "@/lib/messaging";
import { getOwner, jointOwners } from "@/lib/owners";

// Staff send an email from the owner page. Rule 5: never to do not contact.
// Rule 6: optionally to joint owners too, each as their own message (and
// conversation), so each one's reply comes back to them.
export const POST = handle(async (request: Request, { params }: { params: Promise<{ ownerId: string }> }) => {
  const { ownerId } = await params;
  const input = await body<{ threadId?: string; subject: string; body: string; jointOwnerIds?: string[] }>(request);
  const owner = await getOwner(ownerId);
  if (!owner) throw new HttpError(404, "Owner not found");
  if (!input.subject?.trim() || !input.body?.trim()) throw new HttpError(422, "Write a subject and a message");
  if (/\{\{\s*\w+\s*\}\}/.test(input.subject + input.body)) throw new HttpError(422, "Fill in every {{placeholder}} first");
  if (owner.do_not_contact) throw new HttpError(409, "This owner is do not contact: no email of any kind");
  if (!isUsableEmail(owner.email)) throw new HttpError(409, "This owner has no usable email address");

  const recipients = [owner];
  if (input.jointOwnerIds?.length) {
    const joint = await jointOwners(ownerId);
    for (const id of input.jointOwnerIds) {
      const j = joint.find((o) => o.id === id);
      if (j && !j.do_not_contact && isUsableEmail(j.email)) recipients.push(j);
    }
  }
  const results = [];
  for (const r of recipients) {
    const message = await queueMessage(pool, {
      ownerId: r.id,
      threadId: r.id === ownerId ? input.threadId : null,
      subject: input.subject.trim(),
      body: input.body.trim(),
      source: "staff",
    });
    const sent = await deliverNow(message.id);
    results.push({ ownerId: r.id, name: r.full_name, threadId: message.thread_id, status: sent.status, error: sent.last_error });
  }
  return Response.json({ results });
});

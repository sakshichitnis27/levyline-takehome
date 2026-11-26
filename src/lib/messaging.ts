// Sending to and hearing back from owners.
//
// Outbound: every message gets its own reply token, and the email's Reply-To
// is reply+<token>@<EMAIL_RECEIVING_DOMAIN>. All mail is redirected to one
// inbox, so the "from" of a reply tells us nothing; the address it was sent
// *to* tells us exactly which message (so which owner and thread) it answers.

import { randomBytes } from "node:crypto";

import { pool } from "@/lib/db";
import { EmailProviderError, getReceivedEmail, sendEmail } from "@/lib/email";
import { isUsableEmail } from "@/lib/import/plan";
import { logEvent, one, rows, tx, type Db } from "@/lib/sql";

export type MessageRow = {
  id: string;
  thread_id: string | null;
  owner_id: string | null;
  direction: "out" | "in";
  source: string;
  to_address: string | null;
  from_address: string | null;
  reply_token: string | null;
  subject: string;
  body: string;
  status: "queued" | "sending" | "sent" | "failed" | "received";
  attempts: number;
  last_error: string | null;
  retryable: boolean;
  provider_id: string | null;
  created_at: string;
  sent_at: string | null;
};

export function receivingDomain(): string {
  return process.env.EMAIL_RECEIVING_DOMAIN?.trim() || "reply.levyline.local";
}

export function replyAddress(token: string): string {
  return `reply+${token}@${receivingDomain()}`;
}

export function tokenFromAddresses(addresses: string[]): string | null {
  for (const address of addresses) {
    const match = address.match(/reply\+([a-z0-9]+)@/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function newToken(): string {
  return randomBytes(8).toString("hex");
}

export async function queueMessage(
  db: Db,
  input: { ownerId: string; threadId?: string | null; subject: string; body: string; source: "staff" | "automation" | "commitment" },
): Promise<MessageRow> {
  const owner = await one<{ email: string | null }>("select email from owners where id = $1", [input.ownerId], db);
  if (!owner) throw new Error("Owner not found");
  let threadId = input.threadId ?? null;
  if (threadId) {
    const thread = await one("select id from threads where id = $1 and owner_id = $2", [threadId, input.ownerId], db);
    if (!thread) throw new Error("That conversation belongs to someone else");
  } else {
    const { rows: t } = await db.query<{ id: string }>(
      "insert into threads (owner_id, subject) values ($1, $2) returning id",
      [input.ownerId, input.subject.replace(/^(re:\s*)+/i, "")],
    );
    threadId = t[0].id;
  }
  const { rows: m } = await db.query<MessageRow>(
    `insert into messages (thread_id, owner_id, direction, source, to_address, reply_token, subject, body)
     values ($1, $2, 'out', $3, $4, $5, $6, $7) returning *`,
    [threadId, input.ownerId, input.source, owner.email, newToken(), input.subject, input.body],
  );
  return m[0];
}

/**
 * Makes one delivery attempt. The claim (queued/failed -> sending) means two
 * callers can never send the same message at once, and the message id is the
 * provider idempotency key, so a retry after an unclear failure isn't sent twice.
 */
export async function deliver(messageId: string): Promise<MessageRow> {
  const claimed = await one<MessageRow>(
    `update messages set status = 'sending', attempts = attempts + 1
      where id = $1 and direction = 'out' and (status = 'queued' or (status = 'failed' and retryable))
      returning *`,
    [messageId],
  );
  if (!claimed) return (await one<MessageRow>("select * from messages where id = $1", [messageId]))!;

  const owner = await one<{ do_not_contact: boolean; email: string | null }>(
    "select do_not_contact, email from owners where id = $1",
    [claimed.owner_id],
  );
  // Rule 5 is checked again at the last moment, whoever queued the message.
  const blocked = !owner
    ? "Owner no longer exists"
    : owner.do_not_contact
      ? "Not sent: the owner is do not contact"
      : !isUsableEmail(owner.email)
        ? "Not sent: the owner has no usable email address"
        : null;
  if (blocked) {
    return (await one<MessageRow>(
      "update messages set status = 'failed', retryable = false, last_error = $2 where id = $1 returning *",
      [messageId, blocked],
    ))!;
  }

  try {
    const result = await sendEmail({
      to: owner!.email!,
      subject: claimed.subject,
      text: claimed.body,
      replyTo: replyAddress(claimed.reply_token!),
      idempotencyKey: claimed.id,
      reference: claimed.id,
    });
    const sent = (await one<MessageRow>(
      `update messages set status = 'sent', provider_id = $2, sent_at = $3, to_address = $4, last_error = null
        where id = $1 returning *`,
      [messageId, result.providerId, result.sentAt, result.intendedTo],
    ))!;
    return sent;
  } catch (error) {
    const retryable = error instanceof EmailProviderError ? error.retryable : true;
    return (await one<MessageRow>(
      "update messages set status = 'failed', retryable = $2, last_error = $3 where id = $1 returning *",
      [messageId, retryable, (error as Error).message],
    ))!;
  }
}

/** For sends a person is waiting on: a few quick attempts, then report. */
export async function deliverNow(messageId: string, attempts = 3): Promise<MessageRow> {
  let message = await deliver(messageId);
  for (let i = 1; i < attempts && message.status === "failed" && message.retryable; i++) {
    await new Promise((r) => setTimeout(r, 300 * i));
    message = await deliver(messageId);
  }
  const verb = message.source === "commitment" ? "Commitment confirmation" : "Email";
  await logEvent(
    pool,
    message.owner_id,
    "message",
    message.status === "sent"
      ? `${verb} sent: "${message.subject}"`
      : `${verb} failed: "${message.subject}" (${message.last_error})`,
    { messageId: message.id },
  );
  return message;
}

// ---------- Replies ----------

/** Drops the quoted original from a reply, keeping what the owner wrote. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && out.length > 0) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

export type InboundResult =
  | { status: "duplicate" }
  | { status: "matched"; messageId: string; ownerId: string }
  | { status: "unmatched"; messageId: string };

/**
 * Stores a received email exactly once (keyed on the provider's email id, so a
 * webhook delivered twice is harmless) and files it under the owner and
 * thread its reply token points to. Rule 7 and rule 10.
 */
export async function recordInbound(emailId: string): Promise<InboundResult> {
  const existing = await one<{ id: string }>("select id from messages where provider_email_id = $1", [emailId]);
  if (existing) return { status: "duplicate" };

  const received = await getReceivedEmail(emailId);
  const token = tokenFromAddresses(received.to ?? []);
  const original = token
    ? await one<{ id: string; owner_id: string; thread_id: string; subject: string }>(
        "select id, owner_id, thread_id, subject from messages where reply_token = $1",
        [token],
      )
    : null;
  const body = stripQuoted(received.text ?? received.html?.replace(/<[^>]+>/g, " ") ?? "");

  return tx(async (db) => {
    const { rows: inserted } = await db.query<{ id: string }>(
      `insert into messages (thread_id, owner_id, direction, source, from_address, to_address, subject, body, status,
                             provider_email_id, created_at)
       values ($1, $2, 'in', 'owner', $3, $4, $5, $6, 'received', $7, coalesce($8::timestamptz, now()))
       on conflict (provider_email_id) do nothing returning id`,
      [
        original?.thread_id ?? null,
        original?.owner_id ?? null,
        received.from,
        (received.to ?? []).join(", "),
        received.subject || "(no subject)",
        body,
        emailId,
        received.receivedAt ?? null,
      ],
    );
    if (!inserted[0]) return { status: "duplicate" } as const;
    const messageId = inserted[0].id;
    if (!original) return { status: "unmatched", messageId } as const;
    await onOwnerReplied(db, original.owner_id, messageId, received.subject);
    return { status: "matched", messageId, ownerId: original.owner_id } as const;
  });
}

async function onOwnerReplied(db: Db, ownerId: string, messageId: string, subject: string) {
  await logEvent(db, ownerId, "reply", `Replied: "${subject}"`, { messageId });
  // Rule 10: no more automated emails until a staff member resumes them.
  const { rowCount } = await db.query(
    `update owners set automation_paused = true, automation_paused_reason = 'Owner replied; resume when handled'
      where id = $1 and not automation_paused`,
    [ownerId],
  );
  if (rowCount) await logEvent(db, ownerId, "automation", "Automated emails paused because the owner replied");
}

/** Staff attach an unmatched reply to the right owner. */
export async function attachInbound(messageId: string, ownerId: string) {
  return tx(async (db) => {
    const message = await one<MessageRow>(
      "select * from messages where id = $1 and direction = 'in' and owner_id is null for update",
      [messageId],
      db,
    );
    if (!message) throw new Error("That reply has already been attached");
    const { rows: t } = await db.query<{ id: string }>(
      "insert into threads (owner_id, subject) values ($1, $2) returning id",
      [ownerId, message.subject.replace(/^(re:\s*)+/i, "")],
    );
    await db.query("update messages set owner_id = $2, thread_id = $3 where id = $1", [messageId, ownerId, t[0].id]);
    await logEvent(db, ownerId, "reply", `Unmatched reply attached by staff: "${message.subject}"`, { messageId });
    await onOwnerReplied(db, ownerId, messageId, message.subject);
  });
}

export async function unmatchedReplies() {
  return rows<MessageRow>("select * from messages where direction = 'in' and owner_id is null order by created_at desc");
}

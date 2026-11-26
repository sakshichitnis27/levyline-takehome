import { now } from "@/lib/clock";
import { pool } from "@/lib/db";
import { isUsableEmail } from "@/lib/import/plan";
import { deliverNow, queueMessage } from "@/lib/messaging";
import { getOwner, ownerReceivables } from "@/lib/owners";
import { buildContext, render } from "@/lib/render";
import { isMissed, validateCommitment, type CommitmentDraft } from "@/lib/rules";
import { logEvent, one, rows, toCents, tx, type Db } from "@/lib/sql";
import { listTemplates } from "@/lib/templates";
import { formatDate, formatEuro, irishDate } from "@/lib/time";

export class ValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
  }
}

export type CommitmentView = {
  id: string;
  clientId: string;
  clientName: string;
  status: "active" | "broken" | "completed" | "cancelled";
  note: string | null;
  createdAt: string;
  brokenAt: string | null;
  receivables: string[];
  instalments: { id: string; seq: number; dueDate: string; amountCents: number; paidAt: string | null; missed: boolean }[];
};

export async function ownerCommitments(ownerId: string, db: Db = pool): Promise<CommitmentView[]> {
  const today = irishDate(await now(db));
  const list = await rows<{
    id: string;
    client_id: string;
    client_name: string;
    status: CommitmentView["status"];
    note: string | null;
    created_at: string;
    broken_at: string | null;
    receivables: string[];
    instalments: { id: string; seq: number; due_date: string; amount: string; paid_at: string | null }[];
  }>(
    `select c.id, c.client_id, cl.name as client_name, c.status, c.note, c.created_at, c.broken_at,
            (select array_agg(r.demand_ref order by r.demand_ref) from commitment_receivables cr
               join receivables r on r.id = cr.receivable_id where cr.commitment_id = c.id) as receivables,
            (select json_agg(json_build_object('id', i.id, 'seq', i.seq, 'due_date', i.due_date,
                                               'amount', i.amount, 'paid_at', i.paid_at) order by i.seq)
               from instalments i where i.commitment_id = c.id) as instalments
       from commitments c join clients cl on cl.id = c.client_id
      where c.owner_id = $1 order by c.created_at desc`,
    [ownerId],
    db,
  );
  return list.map((c) => ({
    id: c.id,
    clientId: c.client_id,
    clientName: c.client_name,
    status: c.status,
    note: c.note,
    createdAt: c.created_at,
    brokenAt: c.broken_at,
    receivables: c.receivables ?? [],
    instalments: (c.instalments ?? []).map((i) => ({
      id: i.id,
      seq: i.seq,
      dueDate: i.due_date,
      amountCents: toCents(i.amount),
      paidAt: i.paid_at,
      missed: isMissed({ dueDate: i.due_date, paid: Boolean(i.paid_at) }, today),
    })),
  }));
}

/** Records a commitment (rules 11 to 13) and sends the confirmation (rule 16). */
export async function createCommitment(ownerId: string, draft: CommitmentDraft & { note?: string }) {
  const owner = await getOwner(ownerId);
  if (!owner) throw new ValidationError(["Owner not found"]);
  const today = irishDate(await now());

  const created = await tx(async (db) => {
    // Serialise commitments for this owner so two clicks can't both pass validation.
    await db.query("select id from owners where id = $1 for update", [ownerId]);
    const receivables = await ownerReceivables(ownerId, db);
    const active = await one("select id from commitments where owner_id = $1 and client_id = $2 and status = 'active'", [ownerId, draft.clientId], db);
    const errors = validateCommitment({ draft, receivables, hasActiveCommitmentForClient: Boolean(active), today });
    if (errors.length) throw new ValidationError(errors);

    const { rows: c } = await db.query<{ id: string }>(
      "insert into commitments (owner_id, client_id, note) values ($1, $2, $3) returning id",
      [ownerId, draft.clientId, draft.note?.trim() || null],
    );
    const commitmentId = c[0].id;
    for (const id of draft.receivableIds) {
      await db.query("insert into commitment_receivables (commitment_id, receivable_id) values ($1, $2)", [commitmentId, id]);
    }
    for (const [index, i] of draft.instalments.entries()) {
      await db.query(
        "insert into instalments (commitment_id, seq, due_date, amount) values ($1, $2, $3, $4::numeric / 100)",
        [commitmentId, index + 1, i.dueDate, i.amountCents],
      );
    }
    const chosen = receivables.filter((r) => draft.receivableIds.includes(r.id));
    const total = draft.instalments.reduce((s, i) => s + i.amountCents, 0);
    const summary =
      draft.instalments.length === 1
        ? `${formatEuro(total)} on ${formatDate(draft.instalments[0].dueDate)}`
        : `${draft.instalments.length} payments totalling ${formatEuro(total)}, first on ${formatDate(draft.instalments[0].dueDate)}`;
    await logEvent(db, ownerId, "commitment", `Commitment recorded with ${chosen[0].clientName}: ${summary} (covers ${chosen.map((r) => r.demandRef).join(", ")})`);
    return { commitmentId, chosen };
  });

  // Rule 16, unless rule 5 applies.
  let confirmation: { status: string; reason?: string } = { status: "sent" };
  if (owner.do_not_contact) {
    confirmation = { status: "skipped", reason: "Owner is do not contact" };
  } else if (!isUsableEmail(owner.email)) {
    confirmation = { status: "skipped", reason: "No usable email address" };
  } else {
    const template = (await listTemplates()).find((t) => t.id === "commitment-confirmation")!;
    const ctx = buildContext({
      ownerName: owner.full_name,
      clientName: created.chosen[0].clientName,
      receivables: created.chosen,
      schedule: draft.instalments,
    });
    const message = await queueMessage(pool, {
      ownerId,
      subject: render(template.subject, ctx).text,
      body: render(template.body, ctx).text,
      source: "commitment",
    });
    const result = await deliverNow(message.id);
    confirmation = result.status === "sent" ? { status: "sent" } : { status: "failed", reason: result.last_error ?? undefined };
  }
  if (confirmation.status === "skipped") {
    await logEvent(pool, ownerId, "commitment", `Confirmation email not sent: ${confirmation.reason}`);
  }
  return { id: created.commitmentId, confirmation };
}

export async function markInstalmentPaid(ownerId: string, instalmentId: string, paid: boolean) {
  return tx(async (db) => {
    const row = await one<{ commitment_id: string; seq: number; amount: string; status: string }>(
      `select i.commitment_id, i.seq, i.amount, c.status from instalments i join commitments c on c.id = i.commitment_id
        where i.id = $1 and c.owner_id = $2 for update of i`,
      [instalmentId, ownerId],
      db,
    );
    if (!row) throw new ValidationError(["Instalment not found"]);
    await db.query("update instalments set paid_at = $2 where id = $1", [instalmentId, paid ? new Date(await now(db)) : null]);
    await logEvent(db, ownerId, "commitment", `Payment ${row.seq} of ${formatEuro(toCents(row.amount))} marked ${paid ? "paid" : "unpaid"}`);
    const left = await one<{ n: number }>("select count(*)::int as n from instalments where commitment_id = $1 and paid_at is null", [row.commitment_id], db);
    if (left!.n === 0 && row.status === "active") {
      await db.query("update commitments set status = 'completed' where id = $1", [row.commitment_id]);
      await logEvent(db, ownerId, "commitment", "Commitment completed: every payment made");
    }
  });
}

export async function cancelCommitment(ownerId: string, commitmentId: string) {
  const { rowCount } = await pool.query(
    "update commitments set status = 'cancelled' where id = $1 and owner_id = $2 and status in ('active', 'broken')",
    [commitmentId, ownerId],
  );
  if (rowCount) await logEvent(pool, ownerId, "commitment", "Commitment cancelled by staff");
}

/** Rule 15: break active commitments with an instalment unpaid 3 days after its date. */
export async function breakMissedCommitments(db: Db = pool) {
  const today = irishDate(await now(db));
  const due = await rows<{ commitment_id: string; owner_id: string; seq: number; due_date: string; amount: string }>(
    `select distinct on (c.id) c.id as commitment_id, c.owner_id, i.seq, i.due_date, i.amount
       from commitments c join instalments i on i.commitment_id = c.id
      where c.status = 'active' and i.paid_at is null and i.due_date <= ($1::date - 3)
      order by c.id, i.seq`,
    [today],
    db,
  );
  for (const d of due) {
    const { rowCount } = await db.query(
      "update commitments set status = 'broken', broken_at = now() where id = $1 and status = 'active'",
      [d.commitment_id],
    );
    if (rowCount) {
      await logEvent(
        db,
        d.owner_id,
        "commitment",
        `Commitment broken: payment ${d.seq} of ${formatEuro(toCents(d.amount))} due ${formatDate(d.due_date)} was missed. Its receivables can be chased again.`,
      );
    }
  }
  return due.length;
}

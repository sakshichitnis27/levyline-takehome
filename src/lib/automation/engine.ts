// Moves enrolled owners through live automations. Everything it needs is in
// the database (where each owner is, when to look again, which steps have
// run), so stopping the server mid-Wait loses nothing: the next tick picks up
// where the last one stopped.
//
// Never emailing an owner twice for one step rests on two constraints:
// enrollment_steps is unique per (enrollment, step), and the step's message
// id is the provider's idempotency key. The one-a-day rule rests on
// automated_email_days being unique per (owner, Irish date).

import { getClockSettings, now as clockNow } from "@/lib/clock";
import { breakMissedCommitments } from "@/lib/commitments";
import { pool } from "@/lib/db";
import { deliver, queueMessage, type MessageRow } from "@/lib/messaging";
import { getOwner, ownerFacts, ownerReceivables } from "@/lib/owners";
import { buildContext, render } from "@/lib/render";
import { automatedEmailVerdict } from "@/lib/rules";
import { logEvent, one, rows, tx } from "@/lib/sql";
import { formatDateTime, irishDate } from "@/lib/time";

import { nextNode, stepLabel, type Graph, type GraphNode } from "./graph";

const MAX_SEND_ATTEMPTS = 5;
const RECHECK_REAL_MS = 30_000; // how often a held owner is looked at again
const STUCK_SENDING_MS = 2 * 60_000;

type Enrollment = {
  id: string;
  automation_id: string;
  automation_name: string;
  client_id: string;
  client_name: string;
  graph: Graph;
  owner_id: string;
  node_id: string;
  state: "active" | "waiting" | "held" | "failed" | "completed" | "stopped";
  wake_at: string;
  hold_reason: string | null;
  created_at: string;
};

type Step = { id: string; status: "done" | "sending" | "failed" | "waiting"; message_id: string | null; detail: string | null };

/** Virtual time `realMs` real milliseconds from now. */
async function virtualIn(realMs: number): Promise<Date> {
  const settings = await getClockSettings();
  const speed = settings.source === "real" || settings.frozen ? 1 : settings.speed;
  return new Date((await clockNow()).getTime() + realMs * speed);
}

async function update(e: Enrollment, fields: Partial<Pick<Enrollment, "node_id" | "state" | "hold_reason">> & { wake_at?: Date; last_error?: string | null }) {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [e.id];
  for (const [key, value] of Object.entries(fields)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  await pool.query(`update enrollments set ${sets.join(", ")} where id = $1`, params);
  Object.assign(e, fields);
}

async function moveTo(e: Enrollment, nodeId: string | null, now: Date) {
  if (!nodeId) {
    await update(e, { state: "failed", last_error: "The step leads nowhere" });
    return;
  }
  await update(e, { node_id: nodeId, state: "active", hold_reason: null, wake_at: now, last_error: null });
}

async function step(e: Enrollment, nodeId: string): Promise<Step | null> {
  return one<Step>("select id, status, message_id, detail from enrollment_steps where enrollment_id = $1 and node_id = $2", [e.id, nodeId]);
}

async function hold(e: Enrollment, reason: string, wakeAt: Date) {
  if (e.state !== "held" || e.hold_reason !== reason) {
    await logEvent(pool, e.owner_id, "automation", `${e.automation_name}: held at "${stepLabel(e.graph.nodes.find((n) => n.id === e.node_id))}": ${reason}`);
  }
  await update(e, { state: "held", hold_reason: reason, wake_at: wakeAt });
}

async function fail(e: Enrollment, s: Step | null, error: string) {
  if (s) await pool.query("update enrollment_steps set status = 'failed', detail = $2 where id = $1", [s.id, error]);
  await update(e, { state: "failed", last_error: error });
  await logEvent(pool, e.owner_id, "automation", `${e.automation_name}: email failed and needs attention: ${error}`);
}

async function evaluateBranch(e: Enrollment, node: GraphNode): Promise<boolean> {
  switch (node.data.condition) {
    case "has_replied":
      return Boolean(
        await one("select 1 from messages where owner_id = $1 and direction = 'in' and created_at >= $2", [e.owner_id, e.created_at]),
      );
    case "has_commitment":
      return Boolean(
        await one("select 1 from commitments where owner_id = $1 and client_id = $2 and status = 'active'", [e.owner_id, e.client_id]),
      );
    case "balance_over": {
      const receivables = (await ownerReceivables(e.owner_id)).filter((r) => r.clientId === e.client_id);
      const balance = receivables.reduce((s, r) => s + r.outstandingCents, 0);
      return balance > Math.round(Number(node.data.threshold ?? 0) * 100);
    }
    default:
      return false;
  }
}

async function handleEmail(e: Enrollment, node: GraphNode, now: Date) {
  let s = await step(e, node.id);
  if (s?.status === "done") return moveTo(e, nextNode(e.graph, node.id), now);

  if (!s) {
    const owner = await getOwner(e.owner_id);
    if (!owner) return fail(e, null, "Owner no longer exists");
    const receivables = (await ownerReceivables(e.owner_id)).filter((r) => r.clientId === e.client_id);
    const today = irishDate(now);
    const emailedToday = Boolean(await one("select 1 from automated_email_days where owner_id = $1 and day = $2", [e.owner_id, today]));
    const verdict = automatedEmailVerdict({ owner: ownerFacts(owner), receivables, now, alreadyEmailedToday: emailedToday });
    if (!verdict.ok) return hold(e, verdict.reason, verdict.retryAt ?? (await virtualIn(RECHECK_REAL_MS)));

    const ctx = buildContext({
      ownerName: owner.full_name,
      clientName: e.client_name,
      receivables: verdict.chase,
      balanceCents: verdict.balanceCents,
    });
    const subject = render(node.data.subject ?? "", ctx);
    const body = render(node.data.body ?? "", ctx);
    const missing = [...subject.missing, ...body.missing];
    if (missing.length) return fail(e, null, `No value for ${missing.map((m) => `{{${m}}}`).join(", ")}`);

    // Claim the step and today's slot together, or neither.
    const claimed = await tx(async (db) => {
      const { rows: inserted } = await db.query<{ id: string }>(
        `insert into enrollment_steps (enrollment_id, node_id, kind, status) values ($1, $2, 'email', 'sending')
         on conflict (enrollment_id, node_id) do nothing returning id`,
        [e.id, node.id],
      );
      if (!inserted[0]) return null;
      const { rowCount } = await db.query(
        "insert into automated_email_days (owner_id, day, step_id) values ($1, $2, $3) on conflict do nothing",
        [e.owner_id, today, inserted[0].id],
      );
      if (!rowCount) throw new Error("already-emailed-today");
      const message = await queueMessage(db, { ownerId: e.owner_id, subject: subject.text, body: body.text, source: "automation" });
      await db.query("update enrollment_steps set message_id = $2 where id = $1", [inserted[0].id, message.id]);
      return inserted[0].id;
    }).catch((error: Error) => {
      if (error.message === "already-emailed-today") return "busy" as const;
      throw error;
    });
    if (claimed === "busy") return hold(e, "Already had an automated email today", await virtualIn(RECHECK_REAL_MS));
    s = await step(e, node.id);
    if (!s) return;
  }

  if (!s.message_id) return fail(e, s, "The step has no message");
  let message = (await one<MessageRow>("select * from messages where id = $1", [s.message_id]))!;
  if (message.status === "sending" && Date.now() - new Date(message.created_at).getTime() > STUCK_SENDING_MS) {
    // We crashed mid-send. Resend's idempotency key (the message id) makes a retry safe.
    message = (await one<MessageRow>("update messages set status = 'failed', retryable = true where id = $1 returning *", [message.id]))!;
  }
  if (message.status === "queued" || (message.status === "failed" && message.retryable && message.attempts < MAX_SEND_ATTEMPTS)) {
    message = await deliver(message.id);
  }
  if (message.status === "sent") {
    await pool.query("update enrollment_steps set status = 'done', detail = null where id = $1", [s.id]);
    await logEvent(pool, e.owner_id, "automation", `${e.automation_name}: sent "${message.subject}"`, { messageId: message.id });
    return moveTo(e, nextNode(e.graph, node.id), now);
  }
  if (message.status === "failed" && message.retryable && message.attempts < MAX_SEND_ATTEMPTS) {
    // Back off: 10s, 20s, 40s... of real time.
    const wake = await virtualIn(10_000 * 2 ** (message.attempts - 1));
    await pool.query("update enrollment_steps set detail = $2 where id = $1", [s.id, `Attempt ${message.attempts} failed: ${message.last_error}; retrying`]);
    return update(e, { state: "active", wake_at: wake, hold_reason: null, last_error: `Send attempt ${message.attempts} failed (${message.last_error}); retrying` });
  }
  if (message.status === "failed") {
    // Give up on this step; free today's slot, since nothing was delivered.
    await pool.query("delete from automated_email_days where step_id = $1", [s.id]);
    return fail(e, s, `${message.last_error} (after ${message.attempts} attempt${message.attempts === 1 ? "" : "s"})`);
  }
  // Still sending in another worker: look again shortly.
  return update(e, { wake_at: await virtualIn(5_000) });
}

async function advance(e: Enrollment) {
  for (let hops = 0; hops < 25; hops++) {
    const now = await clockNow();
    if (!["active", "waiting", "held"].includes(e.state) || new Date(e.wake_at) > now) return;
    const node = e.graph.nodes.find((n) => n.id === e.node_id);
    if (!node) return fail(e, null, "Its current step no longer exists");

    switch (node.type) {
      case "start":
        await moveTo(e, nextNode(e.graph, node.id), now);
        break;
      case "end":
        await update(e, { state: "completed", hold_reason: null });
        await logEvent(pool, e.owner_id, "automation", `${e.automation_name}: finished`);
        return;
      case "wait": {
        const s = await step(e, node.id);
        if (!s) {
          const wake = new Date(now.getTime() + (node.data.minutes ?? 0) * 60_000);
          await pool.query(
            `insert into enrollment_steps (enrollment_id, node_id, kind, status, detail) values ($1, $2, 'wait', 'waiting', $3)
             on conflict do nothing`,
            [e.id, node.id, `Until ${formatDateTime(wake)}`],
          );
          await update(e, { state: "waiting", wake_at: wake, hold_reason: null });
          return;
        }
        await pool.query("update enrollment_steps set status = 'done' where id = $1", [s.id]);
        await moveTo(e, nextNode(e.graph, node.id), now);
        break;
      }
      case "branch": {
        const answer = await evaluateBranch(e, node);
        await pool.query(
          `insert into enrollment_steps (enrollment_id, node_id, kind, status, detail) values ($1, $2, 'branch', 'done', $3)
           on conflict do nothing`,
          [e.id, node.id, `${stepLabel(node)} ${answer ? "Yes" : "No"}`],
        );
        await moveTo(e, nextNode(e.graph, node.id, answer ? "yes" : "no"), now);
        break;
      }
      case "email":
        await handleEmail(e, node, now);
        if (e.state !== "active") return;
        break;
    }
  }
}

const ENROLLMENT_SELECT = `
  select e.*, a.name as automation_name, a.client_id, c.name as client_name, v.graph
    from enrollments e
    join automations a on a.id = e.automation_id
    join automation_versions v on v.id = e.version_id
    join clients c on c.id = a.client_id`;

/** One pass over every owner whose time has come. Safe to call concurrently. */
export async function tick(): Promise<{ processed: number }> {
  const client = await pool.connect();
  try {
    // One worker at a time, across processes and hot reloads.
    const { rows: lock } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(7461) as ok");
    if (!lock[0].ok) return { processed: 0 };
    try {
      await breakMissedCommitments();
      const now = await clockNow();
      const due = await rows<Enrollment>(
        `${ENROLLMENT_SELECT}
          where e.state in ('active', 'waiting', 'held') and e.wake_at <= $1 and a.status = 'live'
          order by e.wake_at limit 200`,
        [now],
      );
      for (const e of due) {
        try {
          await advance(e);
        } catch (error) {
          console.error(`[automation] enrollment ${e.id}`, error);
          await update(e, { last_error: (error as Error).message, wake_at: await virtualIn(RECHECK_REAL_MS) });
        }
      }
      return { processed: due.length };
    } finally {
      await client.query("select pg_advisory_unlock(7461)");
    }
  } finally {
    client.release();
  }
}

/** Look at an owner's held enrollments now (after staff change something about them). */
export async function wakeOwner(ownerId: string) {
  await pool.query(
    "update enrollments set wake_at = '-infinity' where owner_id = $1 and state = 'held'",
    [ownerId],
  );
}

/** Staff retry a step that gave up. */
export async function retryEnrollment(enrollmentId: string, ownerId: string) {
  const e = await one<{ id: string; node_id: string }>(
    "select id, node_id from enrollments where id = $1 and owner_id = $2 and state = 'failed'",
    [enrollmentId, ownerId],
  );
  if (!e) return false;
  const s = await one<{ id: string; message_id: string | null }>(
    "select id, message_id from enrollment_steps where enrollment_id = $1 and node_id = $2",
    [e.id, e.node_id],
  );
  if (s?.message_id) {
    const m = await one<MessageRow>("select * from messages where id = $1", [s.message_id]);
    if (m && m.status !== "sent" && m.retryable) {
      // Same step, same message, same idempotency key: a fresh set of attempts.
      await pool.query("update messages set attempts = 0 where id = $1", [m.id]);
    } else if (m && m.status !== "sent") {
      // A permanent failure (e.g. a bad address since fixed): start the step again.
      await pool.query("delete from enrollment_steps where id = $1", [s.id]);
    }
  } else if (s) {
    await pool.query("delete from enrollment_steps where id = $1", [s.id]);
  }
  await pool.query(
    "update enrollments set state = 'active', wake_at = '-infinity', last_error = null, hold_reason = null where id = $1",
    [e.id],
  );
  await logEvent(pool, ownerId, "automation", "Staff retried a failed automation step");
  return true;
}

export type EnrollmentView = {
  id: string;
  automationId: string;
  automationName: string;
  state: Enrollment["state"];
  currentStep: string;
  holdReason: string | null;
  lastError: string | null;
  wakeAt: string;
  steps: { nodeId: string; label: string; status: string; detail: string | null; messageStatus: string | null; at: string }[];
};

export async function ownerEnrollments(ownerId: string): Promise<EnrollmentView[]> {
  const list = await rows<Enrollment & { last_error: string | null }>(`${ENROLLMENT_SELECT} where e.owner_id = $1 order by e.created_at desc`, [ownerId]);
  const steps = await rows<{ enrollment_id: string; node_id: string; status: string; detail: string | null; created_at: string; message_status: string | null }>(
    `select s.enrollment_id, s.node_id, s.status, s.detail, s.created_at, m.status as message_status
       from enrollment_steps s join enrollments e on e.id = s.enrollment_id
       left join messages m on m.id = s.message_id
      where e.owner_id = $1 order by s.created_at`,
    [ownerId],
  );
  return list.map((e) => ({
    id: e.id,
    automationId: e.automation_id,
    automationName: e.automation_name,
    state: e.state,
    currentStep: stepLabel(e.graph.nodes.find((n) => n.id === e.node_id)),
    holdReason: e.hold_reason,
    lastError: e.last_error,
    wakeAt: e.wake_at,
    steps: steps
      .filter((s) => s.enrollment_id === e.id)
      .map((s) => ({
        nodeId: s.node_id,
        label: stepLabel(e.graph.nodes.find((n) => n.id === s.node_id)),
        status: s.status,
        detail: s.detail,
        messageStatus: s.message_status,
        at: s.created_at,
      })),
  }));
}

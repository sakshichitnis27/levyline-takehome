import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { tick } from "@/lib/automation/engine";
import type { Graph } from "@/lib/automation/graph";
import { enroll, setStatus } from "@/lib/automation/store";
import { setClock } from "@/lib/clock";
import { breakMissedCommitments, createCommitment } from "@/lib/commitments";
import { pool } from "@/lib/db";
import { commitImport, previewImport } from "@/lib/import/run";
import { deliver, queueMessage, recordInbound } from "@/lib/messaging";
import { ownerReceivables } from "@/lib/owners";

import { csv, decisions, mappingFor, resetDb } from "./helpers";

const first = csv("owners-and-receivables.csv");
const mapping = mappingFor(first);

const at = (iso: string) => setClock({ now: iso, frozen: true });
// Tuesday 1 December 2026, 10:00 Irish time.
const TUESDAY = "2026-12-01T10:00:00Z";

async function importAll() {
  const preview = await previewImport(first, mapping, decisions());
  const merges = Object.fromEntries(preview.mergeSuggestions.map((m) => [m.id, "merge" as const]));
  await commitImport("first.csv", first, mapping, decisions({ merges }));
}

const ownerId = async (name: string) =>
  (await pool.query<{ id: string }>("select id from owners where full_name = $1", [name])).rows[0].id;

const automatedMessages = async (name?: string) =>
  (
    await pool.query(
      `select o.full_name, m.subject, m.status from messages m join owners o on o.id = m.owner_id
        where m.source = 'automation' ${name ? "and o.full_name = $1" : ""} order by m.created_at`,
      name ? [name] : [],
    )
  ).rows;

const twoEmails: Graph = {
  nodes: [
    { id: "s", type: "start", position: { x: 0, y: 0 }, data: {} },
    { id: "e1", type: "email", position: { x: 0, y: 1 }, data: { subject: "First for {{owner_first_name}}", body: "You owe {{balance}} on {{unit_refs}}." } },
    { id: "w", type: "wait", position: { x: 0, y: 2 }, data: { minutes: 5 } },
    { id: "e2", type: "email", position: { x: 0, y: 3 }, data: { subject: "Second", body: "Still {{balance}}." } },
    { id: "end", type: "end", position: { x: 0, y: 4 }, data: {} },
  ],
  edges: [
    { id: "1", source: "s", target: "e1" },
    { id: "2", source: "e1", target: "w" },
    { id: "3", source: "w", target: "e2" },
    { id: "4", source: "e2", target: "end" },
  ],
};

async function liveAutomation(clientName: string, graph: Graph = twoEmails) {
  const { rows } = await pool.query(
    "insert into automations (name, client_id, graph) select 'Test', id, $2 from clients where name = $1 returning id",
    [clientName, JSON.stringify(graph)],
  );
  const id = rows[0].id as string;
  expect(await setStatus(id, "live")).toEqual({ errors: [] });
  return id;
}

async function enrollEveryone(automationId: string, clientName: string) {
  const { rows } = await pool.query(
    `select distinct uo.owner_id from unit_owners uo join receivables r on r.unit_id = uo.unit_id
       join clients c on c.id = r.client_id where c.name = $1 and uo.active`,
    [clientName],
  );
  await enroll(automationId, rows.map((r) => r.owner_id));
}

describe("automations", () => {
  beforeEach(async () => {
    process.env.EMAIL_LOCAL_FAILURE_RATE = "0";
    await resetDb();
    await at(TUESDAY);
    await importAll();
  });
  afterAll(() => pool.end());

  it("emails only owners the rules allow, once per day, and carries on the next day (rules 8, 9)", async () => {
    const id = await liveAutomation("Harbour Property Management");
    await enrollEveryone(id, "Harbour Property Management");
    await tick();

    const sent = await automatedMessages();
    const names = sent.map((m) => m.full_name);
    expect(names).toContain("Liam Gallagher");
    expect(names).not.toContain("Eoin Fitzgerald"); // do not contact
    expect(names).not.toContain("Róisín Ní Bhriain"); // deceased
    expect(names).not.toContain("Gráinne Nolan"); // no email
    expect(names).not.toContain("Pádraig Murphy"); // unusable email
    expect(new Set(names).size).toBe(names.length); // one each

    const held = await pool.query(
      `select o.full_name, e.hold_reason from enrollments e join owners o on o.id = e.owner_id where e.state = 'held' order by 1`,
    );
    expect(held.rows).toContainEqual({ full_name: "Eoin Fitzgerald", hold_reason: "Do not contact" });

    // Five minutes later the Wait is over, but it's still the same day.
    await at("2026-12-01T10:06:00Z");
    await tick();
    await tick();
    expect(await automatedMessages("Liam Gallagher")).toHaveLength(1);
    const liam = await pool.query("select state, hold_reason from enrollments where owner_id = $1", [await ownerId("Liam Gallagher")]);
    expect(liam.rows[0]).toEqual({ state: "held", hold_reason: "Already had an automated email today" });

    // Next morning the second email goes.
    await at("2026-12-02T08:01:00Z");
    await tick();
    expect((await automatedMessages("Liam Gallagher")).map((m) => m.subject)).toEqual(["First for Liam", "Second"]);
    const done = await pool.query("select state from enrollments where owner_id = $1", [await ownerId("Liam Gallagher")]);
    expect(done.rows[0].state).toBe("completed");
  });

  it("holds outside contact hours and on Sundays (rule 9)", async () => {
    await at("2026-12-06T12:00:00Z"); // Sunday
    const id = await liveAutomation("Harbour Property Management");
    await enroll(id, [await ownerId("Liam Gallagher")]);
    await tick();
    expect(await automatedMessages()).toHaveLength(0);
    await at("2026-12-07T07:59:00Z"); // Monday, before 08:00
    await tick();
    expect(await automatedMessages()).toHaveLength(0);
    await at("2026-12-07T08:00:00Z");
    await tick();
    expect(await automatedMessages()).toHaveLength(1);
  });

  it("allows one automated email a day across automations (rule 9)", async () => {
    const a = await liveAutomation("Harbour Property Management");
    const b = await liveAutomation("Harbour Property Management");
    const liam = await ownerId("Liam Gallagher");
    await enroll(a, [liam]);
    await enroll(b, [liam]);
    await tick();
    expect(await automatedMessages("Liam Gallagher")).toHaveLength(1);
  });

  it("retries a flaky provider without ever sending a step twice", async () => {
    process.env.EMAIL_LOCAL_FAILURE_RATE = "1";
    const id = await liveAutomation("Harbour Property Management");
    const liam = await ownerId("Liam Gallagher");
    await enroll(id, [liam]);
    await tick();
    const m1 = await pool.query("select status, attempts from messages where owner_id = $1", [liam]);
    expect(m1.rows).toEqual([{ status: "failed", attempts: 1 }]);
    process.env.EMAIL_LOCAL_FAILURE_RATE = "0";
    await at("2026-12-01T10:01:00Z"); // past the back-off
    await tick();
    await tick();
    const m2 = await pool.query("select status, attempts from messages where owner_id = $1", [liam]);
    expect(m2.rows).toEqual([{ status: "sent", attempts: 2 }]);
  });

  it("stops after a reply until staff resume, and stores a repeated webhook once (rules 7, 10)", async () => {
    const id = await liveAutomation("Harbour Property Management");
    const liam = await ownerId("Liam Gallagher");
    await enroll(id, [liam]);
    await tick();
    const { rows } = await pool.query("select reply_token from messages where owner_id = $1", [liam]);
    const emailId = `test-${Date.now()}`;
    await mkdir(path.join(".mailbox", "inbox"), { recursive: true });
    await writeFile(
      path.join(".mailbox", "inbox", `${emailId}.json`),
      JSON.stringify({
        id: emailId,
        from: "me@example.com",
        to: [`reply+${rows[0].reply_token}@reply.levyline.local`],
        subject: "Re: First for Liam",
        text: "I'll pay Friday.\n\nOn Tue, Levyline wrote:\n> You owe...",
        html: null,
        messageId: null,
        headers: {},
        receivedAt: new Date().toISOString(),
      }),
    );
    expect(await recordInbound(emailId)).toMatchObject({ status: "matched", ownerId: liam });
    expect(await recordInbound(emailId)).toEqual({ status: "duplicate" });
    const replies = await pool.query("select body, thread_id from messages where direction = 'in'");
    expect(replies.rows).toHaveLength(1);
    expect(replies.rows[0].body).toBe("I'll pay Friday.");
    const owner = await pool.query("select automation_paused from owners where id = $1", [liam]);
    expect(owner.rows[0].automation_paused).toBe(true);

    await at("2026-12-02T09:00:00Z");
    await tick();
    expect(await automatedMessages("Liam Gallagher")).toHaveLength(1);
  });

  it("never sends to do not contact, even by hand (rule 5)", async () => {
    const eoin = await ownerId("Eoin Fitzgerald");
    const message = await queueMessage(pool, { ownerId: eoin, subject: "Hi", body: "Hello", source: "staff" });
    const result = await deliver(message.id);
    expect(result.status).toBe("failed");
    expect(result.last_error).toMatch(/do not contact/);
  });

  it("doesn't chase committed receivables until the commitment breaks (rules 14, 15, 16)", async () => {
    const liam = await ownerId("Liam Gallagher");
    const [rec] = await ownerReceivables(liam);
    const result = await createCommitment(liam, {
      clientId: rec.clientId,
      receivableIds: [rec.id],
      instalments: [{ dueDate: "2026-12-05", amountCents: 500_00 }, { dueDate: "2027-01-05", amountCents: 650_00 }],
    });
    expect(result.confirmation.status).toBe("sent");
    const confirmation = await pool.query("select subject, body from messages where source = 'commitment'");
    expect(confirmation.rows[0].body).toMatch(/€500\.00 on 5 December 2026/);

    const id = await liveAutomation("Harbour Property Management");
    await enroll(id, [liam]);
    await tick();
    expect(await automatedMessages("Liam Gallagher")).toHaveLength(0);

    // 5 Dec + 3 days unpaid: broken, and chased again.
    await at("2026-12-08T10:00:00Z");
    await breakMissedCommitments();
    const c = await pool.query("select status from commitments where owner_id = $1", [liam]);
    expect(c.rows[0].status).toBe("broken");
    await pool.query("update enrollments set wake_at = '-infinity'");
    await tick();
    expect(await automatedMessages("Liam Gallagher")).toHaveLength(1);
  });
});

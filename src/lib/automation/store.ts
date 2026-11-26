import { now } from "@/lib/clock";
import { pool } from "@/lib/db";
import { getOwner, ownerFacts, ownerReceivables } from "@/lib/owners";
import { automatedEmailVerdict } from "@/lib/rules";
import { logEvent, one, rows } from "@/lib/sql";
import { irishDate } from "@/lib/time";

import { validateGraph, type Graph } from "./graph";

export type AutomationRow = {
  id: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  graph: Graph;
  status: "draft" | "live" | "paused";
  live_version_id: string | null;
  live_graph: Graph | null;
  updated_at: string;
  counts: Record<string, number> | null;
};

export const STARTER_GRAPH: Graph = {
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
    { id: "end", type: "end", position: { x: 0, y: 360 }, data: {} },
  ],
  edges: [],
};

const SELECT = `
  select a.*, c.name as client_name, v.graph as live_graph,
         (select json_object_agg(state, n) from (select state, count(*)::int as n from enrollments e
             where e.automation_id = a.id group by state) s) as counts
    from automations a
    left join clients c on c.id = a.client_id
    left join automation_versions v on v.id = a.live_version_id`;

export async function listAutomations() {
  return rows<AutomationRow>(`${SELECT} order by a.created_at`);
}

export async function getAutomation(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<AutomationRow>(`${SELECT} where a.id = $1`, [id]);
}

export async function setStatus(id: string, status: "live" | "paused" | "draft") {
  const a = await getAutomation(id);
  if (!a) throw new Error("Automation not found");
  if (status === "live") {
    if (!a.client_id) return { errors: ["Choose which client this automation chases for"] };
    const problems = validateGraph(a.graph);
    if (problems.length) return { errors: problems.map((p) => p.message) };
    let versionId = a.live_version_id;
    if (!versionId || JSON.stringify(a.live_graph) !== JSON.stringify(a.graph)) {
      const v = await one<{ id: string }>(
        "insert into automation_versions (automation_id, graph) values ($1, $2) returning id",
        [id, JSON.stringify(a.graph)],
      );
      versionId = v!.id;
    }
    await pool.query("update automations set status = 'live', live_version_id = $2, updated_at = now() where id = $1", [id, versionId]);
    return { errors: [] };
  }
  await pool.query("update automations set status = $2, updated_at = now() where id = $1", [id, status]);
  if (status === "draft") {
    const stopped = await rows<{ owner_id: string }>(
      "update enrollments set state = 'stopped', updated_at = now() where automation_id = $1 and state not in ('completed', 'stopped') returning owner_id",
      [id],
    );
    for (const s of stopped) await logEvent(pool, s.owner_id, "automation", `${a.name}: turned off by staff`);
  }
  return { errors: [] };
}

export async function enroll(automationId: string, ownerIds: string[]) {
  const a = await getAutomation(automationId);
  if (!a || a.status !== "live" || !a.live_version_id || !a.live_graph) {
    throw new Error("Turn the automation on before adding owners");
  }
  const start = a.live_graph.nodes.find((n) => n.type === "start")!;
  const t = await now();
  const results: { ownerId: string; added: boolean; reason?: string }[] = [];
  for (const ownerId of ownerIds) {
    const receivables = (await ownerReceivables(ownerId)).filter((r) => r.clientId === a.client_id);
    if (!receivables.length) {
      results.push({ ownerId, added: false, reason: `Owes nothing to ${a.client_name}` });
      continue;
    }
    const inserted = await one<{ id: string }>(
      `insert into enrollments (automation_id, version_id, owner_id, node_id, state, wake_at, started_at)
       values ($1, $2, $3, $4, 'active', $5, $5) on conflict do nothing returning id`,
      [automationId, a.live_version_id, ownerId, start.id, t],
    );
    if (!inserted) {
      results.push({ ownerId, added: false, reason: "Already in this automation" });
      continue;
    }
    await logEvent(pool, ownerId, "automation", `Added to automation "${a.name}"`);
    results.push({ ownerId, added: true });
  }
  return results;
}

/** Owners an automation for this client could include, and whether they'd be emailed right now. */
export async function candidates(clientId: string, automationId: string) {
  const list = await rows<{ id: string; full_name: string; enrolled: boolean }>(
    `select distinct o.id, o.full_name,
            exists (select 1 from enrollments e where e.owner_id = o.id and e.automation_id = $2
                     and e.state not in ('completed', 'stopped')) as enrolled
       from owners o join unit_owners uo on uo.owner_id = o.id and uo.active
       join units u on u.id = uo.unit_id and u.archived_at is null
       join receivables r on r.unit_id = u.id and r.client_id = $1
      order by o.full_name`,
    [clientId, automationId],
  );
  const t = await now();
  const today = irishDate(t);
  const out = [];
  for (const o of list) {
    const owner = (await getOwner(o.id))!;
    const receivables = (await ownerReceivables(o.id)).filter((r) => r.clientId === clientId);
    const emailedToday = Boolean(await one("select 1 from automated_email_days where owner_id = $1 and day = $2", [o.id, today]));
    const verdict = automatedEmailVerdict({ owner: ownerFacts(owner), receivables, now: t, alreadyEmailedToday: emailedToday });
    out.push({
      id: o.id,
      name: o.full_name,
      enrolled: o.enrolled,
      balanceCents: receivables.reduce((s, r) => s + r.outstandingCents, 0),
      eligible: verdict.ok || verdict.retryAt !== null,
      note: verdict.ok ? null : verdict.reason,
    });
  }
  return out;
}


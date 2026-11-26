import { pool } from "@/lib/db";
import { isUsableEmail } from "@/lib/import/plan";
import type { OwnerFacts, ReceivableFacts } from "@/lib/rules";
import { one, rows, toCents, type Db } from "@/lib/sql";

export type OwnerRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  do_not_contact: boolean;
  do_not_contact_reason: string | null;
  deceased: boolean;
  deceased_note: string | null;
  automation_paused: boolean;
  automation_paused_reason: string | null;
  created_at: string;
};

export type OwnerReceivable = ReceivableFacts & {
  clientName: string;
  developmentName: string;
  unitId: string;
  unitRef: string;
  kind: string;
  period: string | null;
  amountCents: number;
  paidCents: number;
  notes: string | null;
  disputeReason: string | null;
};

export async function getOwner(id: string, db: Db = pool) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<OwnerRow>("select * from owners where id = $1", [id], db);
}

export function ownerFacts(owner: OwnerRow): OwnerFacts {
  return {
    doNotContact: owner.do_not_contact,
    deceased: owner.deceased,
    automationPaused: owner.automation_paused,
    automationPausedReason: owner.automation_paused_reason,
    emailUsable: isUsableEmail(owner.email),
  };
}

/** Every receivable on the owner's current, un-archived units (joint owners are each liable for all of it). */
export async function ownerReceivables(ownerId: string, db: Db = pool): Promise<OwnerReceivable[]> {
  const list = await rows<{
    id: string;
    client_id: string;
    client_name: string;
    development_name: string;
    unit_id: string;
    unit_ref: string;
    demand_ref: string;
    kind: string;
    period: string | null;
    amount: string;
    paid: string;
    due_date: string;
    disputed: boolean;
    dispute_reason: string | null;
    notes: string | null;
    sold: boolean;
    committed: boolean;
  }>(
    `select r.id, r.client_id, c.name as client_name, d.name as development_name, u.id as unit_id, u.unit_ref,
            r.demand_ref, r.kind, r.period, r.amount, r.paid, r.due_date, r.disputed, r.dispute_reason, r.notes,
            uo.sold_note is not null as sold,
            exists (select 1 from commitment_receivables cr join commitments cm on cm.id = cr.commitment_id
                     where cr.receivable_id = r.id and cm.status = 'active') as committed
       from unit_owners uo
       join units u on u.id = uo.unit_id and u.archived_at is null
       join developments d on d.id = u.development_id
       join receivables r on r.unit_id = u.id
       join clients c on c.id = r.client_id
      where uo.owner_id = $1 and uo.active
      order by c.name, d.name, u.unit_ref, r.due_date, r.demand_ref`,
    [ownerId],
    db,
  );
  return list.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    developmentName: r.development_name,
    unitId: r.unit_id,
    unitRef: r.unit_ref,
    demandRef: r.demand_ref,
    kind: r.kind,
    period: r.period,
    amountCents: toCents(r.amount),
    paidCents: toCents(r.paid),
    outstandingCents: toCents(r.amount) - toCents(r.paid),
    dueDate: r.due_date,
    disputed: r.disputed,
    disputeReason: r.dispute_reason,
    notes: r.notes,
    soldByOwner: r.sold,
    inActiveCommitment: r.committed,
  }));
}

export function balancesByClient(receivables: OwnerReceivable[]) {
  const map = new Map<string, { clientId: string; clientName: string; balanceCents: number }>();
  for (const r of receivables) {
    const entry = map.get(r.clientId) ?? { clientId: r.clientId, clientName: r.clientName, balanceCents: 0 };
    entry.balanceCents += r.outstandingCents;
    map.set(r.clientId, entry);
  }
  return [...map.values()];
}

/** Other people on the same units (for rule 6). */
export async function jointOwners(ownerId: string, db: Db = pool) {
  return rows<OwnerRow & { unit_refs: string[] }>(
    `select o.*, array_agg(distinct u.unit_ref) as unit_refs
       from unit_owners mine
       join unit_owners other on other.unit_id = mine.unit_id and other.owner_id <> mine.owner_id and other.active
       join units u on u.id = mine.unit_id and u.archived_at is null
       join owners o on o.id = other.owner_id
      where mine.owner_id = $1 and mine.active
      group by o.id`,
    [ownerId],
    db,
  );
}

export type OwnerListRow = {
  id: string;
  name: string;
  email: string | null;
  emailUsable: boolean;
  phone: string | null;
  balanceCents: number;
  developments: string[];
  units: string[];
  lastMessageAt: string | null;
  statuses: string[];
};

export async function listOwners(): Promise<OwnerListRow[]> {
  const list = await rows<{
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    do_not_contact: boolean;
    deceased: boolean;
    automation_paused: boolean;
    balance: string | null;
    developments: string[] | null;
    units: string[] | null;
    last_in: string | null;
    disputed: boolean;
    commitment_active: boolean;
    commitment_broken: boolean;
    in_automation: boolean;
    sold: boolean;
  }>(
    `select o.id, o.full_name, o.email, o.phone, o.do_not_contact, o.deceased, o.automation_paused,
            (select sum(r.amount - r.paid) from unit_owners uo join units u on u.id = uo.unit_id and u.archived_at is null
               join receivables r on r.unit_id = u.id where uo.owner_id = o.id and uo.active) as balance,
            (select array_agg(distinct d.name order by d.name) from unit_owners uo join units u on u.id = uo.unit_id and u.archived_at is null
               join developments d on d.id = u.development_id where uo.owner_id = o.id and uo.active) as developments,
            (select array_agg(distinct u.unit_ref order by u.unit_ref) from unit_owners uo join units u on u.id = uo.unit_id and u.archived_at is null
               where uo.owner_id = o.id and uo.active) as units,
            (select max(m.created_at) from messages m where m.owner_id = o.id and m.direction = 'in') as last_in,
            exists (select 1 from unit_owners uo join receivables r on r.unit_id = uo.unit_id
                     where uo.owner_id = o.id and uo.active and r.disputed) as disputed,
            exists (select 1 from commitments c where c.owner_id = o.id and c.status = 'active') as commitment_active,
            exists (select 1 from commitments c where c.owner_id = o.id and c.status = 'broken') as commitment_broken,
            exists (select 1 from enrollments e where e.owner_id = o.id and e.state in ('active', 'waiting', 'held', 'failed')) as in_automation,
            exists (select 1 from unit_owners uo where uo.owner_id = o.id and uo.active and uo.sold_note is not null) as sold
       from owners o
       where exists (select 1 from unit_owners uo where uo.owner_id = o.id)
      order by o.full_name`,
  );
  return list.map((o) => ({
    id: o.id,
    name: o.full_name,
    email: o.email,
    emailUsable: isUsableEmail(o.email),
    phone: o.phone,
    balanceCents: toCents(o.balance),
    developments: o.developments ?? [],
    units: o.units ?? [],
    lastMessageAt: o.last_in,
    statuses: [
      o.do_not_contact && "Do not contact",
      o.deceased && "Deceased",
      o.disputed && "In dispute",
      o.commitment_active && "Commitment active",
      o.commitment_broken && "Commitment broken",
      o.in_automation && "In automation",
      o.automation_paused && "Automation paused",
      o.sold && "Sold unit",
      !(o.units ?? []).length && "No current units",
    ].filter(Boolean) as string[],
  }));
}

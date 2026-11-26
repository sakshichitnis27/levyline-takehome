import type { PoolClient } from "pg";

import { pool } from "@/lib/db";
import { logEvent, rows, tx, type Db } from "@/lib/sql";

import { formatCents, parseCsv } from "./normalize";
import { planImport, type Decisions, type ImportPlan, type Mapping, type Snapshot } from "./plan";

export async function loadSnapshot(db: Db = pool): Promise<Snapshot> {
  // Sequential on purpose: `db` may be a single client inside a transaction.
  const clients = await rows<Snapshot["clients"][number]>("select id, name from clients", [], db);
  const developments = await rows<Snapshot["developments"][number]>(
    `select id, client_id as "clientId", name from developments`,
    [],
    db,
  );
  const units = await rows<Snapshot["units"][number]>(
    `select u.id, u.development_id as "developmentId", u.unit_ref as "unitRef", u.block,
            u.archived_at is not null as archived,
            coalesce(array_agg(uo.owner_id) filter (where uo.active), '{}') as "activeOwnerIds"
       from units u left join unit_owners uo on uo.unit_id = u.id
      group by u.id`,
    [],
    db,
  );
  const owners = await rows<Snapshot["owners"][number]>(
    `select id, full_name as "fullName", email, phone, address,
            do_not_contact as "doNotContact", deceased, imported from owners`,
    [],
    db,
  );
  const identities = await rows<Snapshot["identities"][number]>(
    `select name_key as "nameKey", email_key as "emailKey", owner_id as "ownerId" from owner_identities`,
    [],
    db,
  );
  const receivables = await rows<Snapshot["receivables"][number]>(
    `select id, client_id as "clientId", demand_ref as "demandRef", disputed, imported from receivables`,
    [],
    db,
  );
  return { clients, developments, units, owners, identities, receivables };
}

export async function previewImport(csv: string, mapping: Mapping, decisions: Decisions): Promise<ImportPlan> {
  return planImport(parseCsv(csv), mapping, await loadSnapshot(), decisions);
}

const FIELD_LABELS: Record<string, string> = {
  fullName: "name",
  email: "email",
  phone: "phone",
  address: "address",
  doNotContact: "do not contact",
  deceased: "deceased",
  amountCents: "amount",
  paidCents: "paid",
  dueDate: "due date",
  unitKey: "unit",
};

export async function commitImport(
  fileName: string,
  csv: string,
  mapping: Mapping,
  decisions: Decisions,
): Promise<{ importId: string; plan: ImportPlan }> {
  return tx(async (db) => {
    // One import at a time, so two staff importing at once can't race.
    await db.query("select pg_advisory_xact_lock(4242)");
    const plan = planImport(parseCsv(csv), mapping, await loadSnapshot(db), decisions);
    if (!plan.ready) throw new Error("Every possible duplicate needs a decision before importing");
    const importId = await applyPlan(db, fileName, plan, decisions);
    return { importId, plan };
  });
}

async function applyPlan(db: PoolClient, fileName: string, plan: ImportPlan, decisions: Decisions) {
  const source = `import of ${fileName}`;
  const clientIds = new Map<string, string>();
  const devIds = new Map<string, string>();
  const clientId = async (name: string) => {
    if (!clientIds.has(name)) {
      const { rows: r } = await db.query<{ id: string }>(
        "insert into clients (name) values ($1) on conflict (name) do update set name = excluded.name returning id",
        [name],
      );
      clientIds.set(name, r[0].id);
    }
    return clientIds.get(name)!;
  };
  const devId = async (client: string, dev: string) => {
    const key = `${client}|${dev}`;
    if (!devIds.has(key)) {
      const cid = await clientId(client);
      const { rows: r } = await db.query<{ id: string }>(
        `insert into developments (client_id, name) values ($1, $2)
         on conflict (client_id, name) do update set name = excluded.name returning id`,
        [cid, dev],
      );
      devIds.set(key, r[0].id);
    }
    return devIds.get(key)!;
  };

  // ---- Owners ----
  const ownerIds = new Map<string, string>();
  for (const o of plan.owners) {
    let id = o.existingId;
    const v = o.values;
    if (!id) {
      const { rows: r } = await db.query<{ id: string }>(
        `insert into owners (full_name, email, phone, address, do_not_contact, do_not_contact_reason,
                             deceased, deceased_note, imported)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [v.fullName, v.email, v.phone, v.address, v.doNotContact, v.doNotContactReason, v.deceased, v.deceasedNote, o.imported],
      );
      id = r[0].id;
      await logEvent(db, id, "import", `Created by ${source}`, { warnings: o.warnings });
      if (v.doNotContact) await logEvent(db, id, "status", `Marked do not contact from the import note: "${v.doNotContactReason}"`);
      if (v.deceased) await logEvent(db, id, "status", `Marked deceased from the import note: "${v.deceasedNote}"`);
    } else {
      const sets: string[] = ["imported = $2", "updated_at = now()"];
      const params: unknown[] = [id, o.imported];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      for (const c of o.changes) {
        if (c.field === "fullName") set("full_name", v.fullName);
        if (c.field === "email") set("email", v.email);
        if (c.field === "phone") set("phone", v.phone);
        if (c.field === "address") set("address", v.address);
        if (c.field === "doNotContact") {
          set("do_not_contact", true);
          set("do_not_contact_reason", v.doNotContactReason);
        }
        if (c.field === "deceased") {
          set("deceased", true);
          set("deceased_note", v.deceasedNote);
        }
      }
      await db.query(`update owners set ${sets.join(", ")} where id = $1`, params);
      if (o.changes.length) {
        await logEvent(
          db,
          id,
          "import",
          `Updated by ${source}: ${o.changes.map((c) => `${FIELD_LABELS[c.field] ?? c.field} ${c.from ?? "(blank)"} → ${c.to ?? "(blank)"}`).join("; ")}`,
        );
      }
    }
    for (const identity of o.identities) {
      await db.query(
        `insert into owner_identities (name_key, email_key, owner_id) values ($1, $2, $3)
         on conflict (name_key, email_key) do update set owner_id = excluded.owner_id`,
        [identity.nameKey, identity.emailKey, id],
      );
    }
    ownerIds.set(o.ref, id);
  }
  for (const m of plan.mergeSuggestions) {
    if (m.decision !== "merge") continue;
    const target = m.members.map((mem) => mem.existingOwnerId).find(Boolean) ?? null;
    const ownerId = target ?? ownerIds.get(`new:${m.members[0].key}`);
    if (ownerId) {
      await logEvent(db, ownerId, "merge", `Staff confirmed ${m.members.length} records are the same person (${m.reasons.join(", ")})`);
    }
  }

  // ---- Units ----
  const unitIds = new Map<string, string>();
  const ownerNotes = new Map<string, string[]>();
  const note = (ownerId: string, text: string) => {
    if (!ownerNotes.has(ownerId)) ownerNotes.set(ownerId, []);
    ownerNotes.get(ownerId)!.push(text);
  };
  for (const u of plan.units) {
    const did = await devId(u.clientName, u.developmentName);
    const { rows: r } = await db.query<{ id: string }>(
      `insert into units (development_id, unit_ref, block) values ($1, $2, $3)
       on conflict (development_id, unit_ref) do update set block = excluded.block, archived_at = null
       returning id`,
      [did, u.unitRef, u.block],
    );
    const unitId = r[0].id;
    unitIds.set(u.key, unitId);
    for (const ref of u.ownerRefs) {
      const ownerId = ownerIds.get(ref)!;
      const sold = u.soldOwnerRefs.includes(ref) ? u.soldNote : null;
      await db.query(
        `insert into unit_owners (unit_id, owner_id, active, sold_note) values ($1, $2, true, $3)
         on conflict (unit_id, owner_id) do update
           set active = true, ended_at = null, sold_note = coalesce(unit_owners.sold_note, excluded.sold_note)`,
        [unitId, ownerId, sold],
      );
      if (u.addedOwnerRefs.includes(ref) && u.existingId) note(ownerId, `added as an owner of ${u.label}`);
      if (sold) note(ownerId, `note on ${u.label}: "${sold}"`);
    }
    for (const removed of u.removedOwnerIds) {
      await db.query("update unit_owners set active = false, ended_at = now() where unit_id = $1 and owner_id = $2", [unitId, removed]);
      await logEvent(db, removed, "import", `No longer an owner of ${u.label}: not listed in the ${source}`);
    }
    if (u.unarchive) for (const ref of u.ownerRefs) note(ownerIds.get(ref)!, `${u.label} is back in the export and was un-archived`);
  }

  // ---- Receivables ----
  const unitOwners = new Map<string, string[]>();
  for (const u of plan.units) unitOwners.set(u.key, u.ownerRefs.map((r) => ownerIds.get(r)!));
  for (const rec of plan.receivables) {
    const cid = await clientId(rec.clientName);
    const unitId = unitIds.get(rec.values.unitKey)!;
    const v = rec.values;
    if (!rec.existingId) {
      await db.query(
        `insert into receivables (client_id, unit_id, demand_ref, kind, period, amount, paid, due_date, notes,
                                  disputed, dispute_reason, imported)
         values ($1, $2, $3, $4, $5, $6::numeric / 100, $7::numeric / 100, $8, $9, $10, $11, $12)`,
        [cid, unitId, rec.demandRef, v.kind, v.period, v.amountCents, v.paidCents, v.dueDate, v.notes, Boolean(rec.setDisputed), rec.setDisputed, rec.imported],
      );
      for (const ownerId of unitOwners.get(v.unitKey) ?? []) {
        note(ownerId, `${rec.demandRef} ${v.kind} ${formatCents(v.amountCents)} added`);
        if (rec.setDisputed) note(ownerId, `${rec.demandRef} marked disputed from the note "${rec.setDisputed}"`);
      }
    } else if (rec.changes.length) {
      const sets = ["imported = $2", "updated_at = now()"];
      const params: unknown[] = [rec.existingId, rec.imported];
      const set = (column: string, value: unknown, cast = "") => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      for (const c of rec.changes) {
        if (c.field === "kind") set("kind", v.kind);
        if (c.field === "period") set("period", v.period);
        if (c.field === "amountCents") set("amount", v.amountCents, "::numeric / 100");
        if (c.field === "paidCents") set("paid", v.paidCents, "::numeric / 100");
        if (c.field === "dueDate") set("due_date", v.dueDate);
        if (c.field === "notes") set("notes", v.notes);
        if (c.field === "unitKey") set("unit_id", unitId);
        if (c.field === "disputed") {
          set("disputed", true);
          set("dispute_reason", rec.setDisputed);
        }
      }
      await db.query(`update receivables set ${sets.join(", ")} where id = $1`, params);
      const summary = rec.changes.map((c) => `${FIELD_LABELS[c.field] ?? c.field} ${c.from ?? "(blank)"} → ${c.to ?? "(blank)"}`).join(", ");
      for (const ownerId of unitOwners.get(v.unitKey) ?? []) note(ownerId, `${rec.demandRef} updated: ${summary}`);
    }
  }

  // ---- Units staff chose to archive ----
  for (const missing of plan.missingUnits) {
    if (!decisions.archiveUnitIds.includes(missing.id)) continue;
    await db.query("update units set archived_at = now() where id = $1", [missing.id]);
    const owners = await rows<{ owner_id: string }>("select owner_id from unit_owners where unit_id = $1 and active", [missing.id], db);
    for (const o of owners) await logEvent(db, o.owner_id, "import", `${missing.label} archived: it is not in the ${source}`);
  }

  for (const [ownerId, notes] of ownerNotes) {
    await logEvent(db, ownerId, "import", `From the ${source}: ${notes.join("; ")}`);
  }

  const { rows: r } = await db.query<{ id: string }>(
    "insert into imports (file_name, summary, skipped) values ($1, $2, $3) returning id",
    [fileName, JSON.stringify(plan.counts), JSON.stringify(plan.skipped)],
  );
  return r[0].id;
}

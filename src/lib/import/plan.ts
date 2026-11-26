// Builds an import plan from CSV rows and a snapshot of the database. It is
// pure, so the preview staff see and the import that runs are computed by the
// same code (and tested in plan.test.ts).

import {
  collapse,
  detectDateOrder,
  formatCents,
  looseNameKey,
  nameKey,
  parseAmount,
  parseDate,
  placeKey,
  readNoteFlags,
  tidyEmail,
  tidyName,
  tidyPhone,
  type DateOrder,
} from "./normalize";

// ---------- Fields and mapping ----------

export const FIELDS = [
  { id: "client", label: "Client", required: true, synonyms: ["client", "managing agent", "agent"] },
  { id: "development", label: "Development", required: true, synonyms: ["development", "estate", "scheme", "building"] },
  { id: "block", label: "Block", required: false, synonyms: ["block"] },
  { id: "unitRef", label: "Unit ref", required: true, synonyms: ["unit ref", "unit", "unit reference", "apartment"] },
  { id: "owner1", label: "Owner name", required: true, synonyms: ["owner 1", "owner", "owner name", "name"] },
  { id: "owner2", label: "Joint owner name", required: false, synonyms: ["owner 2", "joint owner", "second owner"] },
  { id: "email", label: "Email", required: false, synonyms: ["owner email", "email", "e-mail", "email address"] },
  { id: "phone", label: "Phone", required: false, synonyms: ["owner phone", "phone", "mobile", "telephone"] },
  { id: "address1", label: "Address line 1", required: false, synonyms: ["corr address 1", "address 1", "address"] },
  { id: "address2", label: "Address line 2", required: false, synonyms: ["corr address 2", "address 2"] },
  { id: "town", label: "Town", required: false, synonyms: ["corr town", "town", "city"] },
  { id: "county", label: "County", required: false, synonyms: ["corr county", "county"] },
  { id: "postcode", label: "Postcode", required: false, synonyms: ["corr postcode", "postcode", "eircode"] },
  { id: "demandRef", label: "Demand ref", required: true, synonyms: ["demand ref", "reference", "invoice", "demand"] },
  { id: "demandType", label: "Type", required: true, synonyms: ["demand type", "type", "charge type"] },
  { id: "period", label: "Period", required: false, synonyms: ["period", "year"] },
  { id: "amount", label: "Amount", required: true, synonyms: ["amount", "charge", "value"] },
  { id: "paid", label: "Paid", required: false, synonyms: ["paid", "amount paid", "received"] },
  { id: "dueDate", label: "Due date", required: true, synonyms: ["due date", "due", "date due"] },
  { id: "notes", label: "Notes", required: false, synonyms: ["notes", "note", "comments"] },
] as const;

export type FieldId = (typeof FIELDS)[number]["id"];
export type Mapping = Partial<Record<FieldId, number>>;

export function suggestMapping(headers: string[]): Mapping {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const headerKeys = headers.map(norm);
  const used = new Set<number>();
  const mapping: Mapping = {};
  // Exact synonym matches first, in synonym order, so "Owner Email" doesn't become "Owner name".
  for (const field of FIELDS) {
    for (const synonym of field.synonyms) {
      const index = headerKeys.findIndex((h, i) => h === synonym && !used.has(i));
      if (index >= 0) {
        mapping[field.id] = index;
        used.add(index);
        break;
      }
    }
  }
  return mapping;
}

// ---------- Snapshot of the database ----------

export type SnapshotOwner = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  doNotContact: boolean;
  deceased: boolean;
  imported: Record<string, unknown>;
};

export type Snapshot = {
  clients: { id: string; name: string }[];
  developments: { id: string; clientId: string; name: string }[];
  units: {
    id: string;
    developmentId: string;
    unitRef: string;
    block: string | null;
    archived: boolean;
    activeOwnerIds: string[];
  }[];
  owners: SnapshotOwner[];
  identities: { nameKey: string; emailKey: string; ownerId: string }[];
  receivables: {
    id: string;
    clientId: string;
    demandRef: string;
    disputed: boolean;
    imported: Record<string, unknown>;
  }[];
};

export const emptySnapshot: Snapshot = {
  clients: [],
  developments: [],
  units: [],
  owners: [],
  identities: [],
  receivables: [],
};

export type Decisions = {
  dateOrder: DateOrder | null;
  merges: Record<string, "merge" | "separate">;
  archiveUnitIds: string[];
};

// ---------- Plan types ----------

export type SkippedRow = { line: number; demandRef: string; reasons: string[]; cells: string[] };
export type Note = { line?: number; text: string };

export type MergeMember = {
  key: string;
  name: string;
  email: string | null;
  units: string[];
  lines: number[];
  existingOwnerId: string | null;
};
export type MergeSuggestion = {
  id: string;
  reasons: string[];
  members: MergeMember[];
  decision: "merge" | "separate" | null;
};

export type OwnerValues = {
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  doNotContact: boolean;
  doNotContactReason: string | null;
  deceased: boolean;
  deceasedNote: string | null;
};

export type Change = { field: string; from: string | null; to: string | null };

export type OwnerPlan = {
  ref: string;
  existingId: string | null;
  status: "create" | "update" | "unchanged";
  values: OwnerValues; // what the owner will look like
  imported: Record<string, unknown>; // the new snapshot of file values
  changes: Change[];
  identities: { nameKey: string; emailKey: string }[];
  emailUsable: boolean;
  warnings: string[];
  lines: number[];
};

export type UnitPlan = {
  key: string;
  label: string;
  clientName: string;
  developmentName: string;
  unitRef: string;
  block: string | null;
  existingId: string | null;
  status: "create" | "update" | "unchanged";
  ownerRefs: string[];
  soldOwnerRefs: string[];
  soldNote: string | null;
  addedOwnerRefs: string[];
  removedOwnerIds: string[];
  unarchive: boolean;
};

export type ReceivableValues = {
  kind: string;
  period: string | null;
  amountCents: number;
  paidCents: number;
  dueDate: string;
  notes: string | null;
  unitKey: string;
};

export type ReceivablePlan = {
  clientName: string;
  demandRef: string;
  existingId: string | null;
  status: "create" | "update" | "unchanged";
  values: ReceivableValues;
  setDisputed: string | null; // dispute reason, when the file newly says so
  imported: Record<string, unknown>; // new snapshot of the file's values
  changes: Change[];
  line: number;
};

export type MissingUnit = { id: string; label: string; archive: boolean };

export type ImportPlan = {
  headers: string[];
  rowCount: number;
  dateFormat: { detected: DateOrder | null; evidence: string | null; conflicting: boolean; used: DateOrder | null };
  skipped: SkippedRow[];
  tidied: Note[];
  warnings: Note[];
  mergeSuggestions: MergeSuggestion[];
  owners: OwnerPlan[];
  units: UnitPlan[];
  receivables: ReceivablePlan[];
  missingUnits: MissingUnit[];
  ready: boolean; // false until every merge suggestion has a decision
  counts: {
    owners: Record<OwnerPlan["status"], number>;
    units: Record<UnitPlan["status"], number>;
    receivables: Record<ReceivablePlan["status"], number>;
    skipped: number;
    noUsableEmail: number;
  };
};

// ---------- Internals ----------

type Slot = {
  name: string;
  email: ReturnType<typeof tidyEmail>;
  phone: ReturnType<typeof tidyPhone>;
  address: string | null;
};

type Row = {
  line: number;
  cells: string[];
  clientName: string;
  developmentName: string;
  unitRef: string;
  unitKey: string;
  unitLabel: string;
  block: string | null;
  demandRef: string;
  kind: string;
  period: string | null;
  amountCents: number;
  paidCents: number;
  dueDate: string;
  notes: string | null;
  owners: Slot[];
  flags: ReturnType<typeof readNoteFlags>;
};

type FileIdentity = {
  key: string;
  nameKey: string;
  emailKey: string;
  looseKey: string;
  names: Map<string, number>;
  emails: Map<string, { usable: boolean; count: number; problem?: string }>;
  phones: Map<string, { usable: boolean; count: number }>;
  addresses: Map<string, number>;
  units: Set<string>;
  unitLabels: Set<string>;
  lines: number[];
  dncNotes: string[];
  deceasedNotes: string[];
  existingOwnerId: string | null;
};

function bump<K>(map: Map<K, number>, key: K) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mostCommon<K>(map: Map<K, number>): K | null {
  let best: K | null = null;
  let bestCount = -1;
  for (const [key, count] of map) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function str(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : String(value);
}

// ---------- The planner ----------

export function planImport(
  table: string[][],
  mapping: Mapping,
  snapshot: Snapshot,
  decisions: Decisions,
): ImportPlan {
  const [headers = [], ...dataRows] = table;
  const cell = (cells: string[], field: FieldId) => {
    const index = mapping[field];
    return index === undefined ? "" : (cells[index] ?? "");
  };

  const detected = detectDateOrder(dataRows.map((cells) => cell(cells, "dueDate")));
  const dateOrder = decisions.dateOrder;

  const skipped: SkippedRow[] = [];
  const tidied: Note[] = [];
  const warnings: Note[] = [];

  // Canonical spellings for clients and developments: whatever is already in
  // the database, else the most common spelling in the file.
  const clientSpellings = new Map<string, Map<string, number>>();
  const devSpellings = new Map<string, Map<string, number>>();
  for (const cells of dataRows) {
    const c = collapse(cell(cells, "client"));
    const d = collapse(cell(cells, "development"));
    if (!c || !d) continue;
    const ck = placeKey(c);
    if (!clientSpellings.has(ck)) clientSpellings.set(ck, new Map());
    bump(clientSpellings.get(ck)!, c);
    const dk = `${ck}|${placeKey(d)}`;
    if (!devSpellings.has(dk)) devSpellings.set(dk, new Map());
    bump(devSpellings.get(dk)!, d);
  }
  const dbClientByKey = new Map(snapshot.clients.map((c) => [placeKey(c.name), c]));
  const dbDevByKey = new Map(
    snapshot.developments.map((d) => {
      const client = snapshot.clients.find((c) => c.id === d.clientId)!;
      return [`${placeKey(client.name)}|${placeKey(d.name)}`, d];
    }),
  );
  const canonicalClient = (ck: string) =>
    dbClientByKey.get(ck)?.name ?? mostCommon(clientSpellings.get(ck)!)!;
  const canonicalDev = (dk: string) => dbDevByKey.get(dk)?.name ?? mostCommon(devSpellings.get(dk)!)!;

  // Unit keys seen anywhere in the file, even on skipped rows, so a unit
  // isn't reported "missing" just because its rows had problems.
  const unitKeysInFile = new Set<string>();
  const clientKeysInFile = new Set<string>();

  // ---- 1. Read each row ----
  const rows: Row[] = [];
  dataRows.forEach((cells, index) => {
    const line = index + 2;
    const reasons: string[] = [];
    const rowTidies: string[] = [];

    const clientRaw = collapse(cell(cells, "client"));
    const devRaw = collapse(cell(cells, "development"));
    const unitRef = collapse(cell(cells, "unitRef")).toUpperCase();
    const demandRef = collapse(cell(cells, "demandRef"));
    const kind = collapse(cell(cells, "demandType"));
    if (!clientRaw) reasons.push("client is blank");
    if (!devRaw) reasons.push("development is blank");
    if (!unitRef) reasons.push("unit ref is blank, so the receivable can't be put on a unit");
    if (!demandRef) reasons.push("demand ref is blank");
    if (!kind) reasons.push("demand type is blank");

    let clientName = clientRaw;
    let developmentName = devRaw;
    let unitKey = "";
    if (clientRaw && devRaw) {
      const ck = placeKey(clientRaw);
      const dk = `${ck}|${placeKey(devRaw)}`;
      clientName = canonicalClient(ck);
      developmentName = canonicalDev(dk);
      if (clientName !== clientRaw) rowTidies.push(`client "${clientRaw}" → "${clientName}"`);
      if (developmentName !== devRaw) rowTidies.push(`development "${devRaw}" → "${developmentName}"`);
      clientKeysInFile.add(ck);
      if (unitRef) {
        unitKey = `${dk}|${unitRef}`;
        unitKeysInFile.add(unitKey);
      }
    }

    const amount = parseAmount(cell(cells, "amount"), "amount");
    if (!amount.ok) reasons.push(amount.reason);
    else if (amount.tidied) rowTidies.push(amount.tidied);

    let paidCents = 0;
    if (mapping.paid !== undefined) {
      const paid = parseAmount(cell(cells, "paid"), "paid");
      if (!paid.ok) reasons.push(paid.reason);
      else {
        paidCents = paid.value;
        if (paid.tidied) rowTidies.push(paid.tidied);
      }
    }

    const due = parseDate(cell(cells, "dueDate"), dateOrder, "due date");
    if (!due.ok) reasons.push(due.reason);
    else if (due.tidied) rowTidies.push(due.tidied);

    const owners: Slot[] = [];
    const owner1 = tidyName(cell(cells, "owner1"));
    if (!owner1.ok) reasons.push("owner name is blank");
    else {
      if (owner1.tidied) rowTidies.push(owner1.tidied);
      const email = tidyEmail(cell(cells, "email"));
      if (email?.tidied && email.usable) rowTidies.push(email.tidied);
      const phone = tidyPhone(cell(cells, "phone"));
      if (phone?.tidied) rowTidies.push(phone.tidied);
      const address = (["address1", "address2", "town", "county", "postcode"] as const)
        .map((f) => collapse(cell(cells, f)))
        .filter(Boolean)
        .join(", ");
      owners.push({ name: owner1.value, email, phone, address: address || null });
    }
    const owner2Raw = cell(cells, "owner2");
    if (owner2Raw.trim()) {
      const owner2 = tidyName(owner2Raw);
      if (owner2.ok) {
        if (owner2.tidied) rowTidies.push(owner2.tidied);
        // The export has one email/phone column; it belongs to the first owner.
        owners.push({ name: owner2.value, email: null, phone: null, address: null });
      }
    }

    if (reasons.length) {
      skipped.push({ line, demandRef: demandRef || "(none)", reasons, cells });
      return;
    }
    for (const t of rowTidies) tidied.push({ line, text: t });

    const notes = collapse(cell(cells, "notes")) || null;
    const unitLabel = `${unitRef} · ${developmentName}`;
    const amountCents = (amount as { value: number }).value;
    if (amountCents > 0 && paidCents > amountCents) {
      warnings.push({
        line,
        text: `${demandRef}: paid ${formatCents(paidCents)} is more than the amount ${formatCents(amountCents)}; the overpayment counts as a credit on ${unitLabel}`,
      });
    }
    rows.push({
      line,
      cells,
      clientName,
      developmentName,
      unitRef,
      unitKey,
      unitLabel,
      block: collapse(cell(cells, "block")) || null,
      demandRef,
      kind,
      period: collapse(cell(cells, "period")) || null,
      amountCents,
      paidCents,
      dueDate: (due as { value: string }).value,
      notes,
      owners,
      flags: readNoteFlags(notes ?? ""),
    });
  });

  // ---- 2. The same demand more than once ----
  const signature = (r: Row) =>
    JSON.stringify([r.unitKey, r.kind, r.period, r.amountCents, r.paidCents, r.dueDate, r.notes, r.owners.map((o) => nameKey(o.name))]);
  const byDemand = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${placeKey(r.clientName)}|${r.demandRef}`;
    if (!byDemand.has(k)) byDemand.set(k, []);
    byDemand.get(k)!.push(r);
  }
  const keptRows: Row[] = [];
  for (const group of byDemand.values()) {
    if (group.length === 1) {
      keptRows.push(group[0]);
      continue;
    }
    const sigs = new Set(group.map(signature));
    if (sigs.size === 1) {
      keptRows.push(group[0]);
      for (const dup of group.slice(1)) {
        tidied.push({ line: dup.line, text: `${dup.demandRef} repeats row ${group[0].line} exactly; the repeat was ignored` });
      }
      continue;
    }
    const lines = group.map((g) => g.line).join(", ");
    const differences: string[] = [];
    const describe = (label: string, values: string[]) => {
      if (new Set(values).size > 1) differences.push(`${label} (${values.join(" vs ")})`);
    };
    describe("amount", group.map((g) => formatCents(g.amountCents)));
    describe("paid", group.map((g) => formatCents(g.paidCents)));
    describe("due date", group.map((g) => g.dueDate));
    describe("unit", group.map((g) => g.unitRef));
    describe("owners", group.map((g) => g.owners.map((o) => o.name).join(" & ")));
    const reason = `${group[0].demandRef} appears on rows ${lines} with different ${differences.join(", ") || "details"}; not choosing one`;
    for (const r of group) skipped.push({ line: r.line, demandRef: r.demandRef, reasons: [reason], cells: r.cells });
  }
  keptRows.sort((a, b) => a.line - b.line);
  // Rows that only repeat a kept row still tell us about the people on it.
  const contactRows = rows.filter((r) => !skipped.some((s) => s.line === r.line));

  // ---- 3. People in the file ----
  const identities = new Map<string, FileIdentity>();
  const identityFor = (slot: Slot, row: Row) => {
    const nk = nameKey(slot.name);
    const ek = slot.email ? slot.email.address : `unit:${row.unitKey}`;
    const key = `${nk}\u0000${ek}`;
    let identity = identities.get(key);
    if (!identity) {
      identity = {
        key,
        nameKey: nk,
        emailKey: ek,
        looseKey: looseNameKey(slot.name),
        names: new Map(),
        emails: new Map(),
        phones: new Map(),
        addresses: new Map(),
        units: new Set(),
        unitLabels: new Set(),
        lines: [],
        dncNotes: [],
        deceasedNotes: [],
        existingOwnerId: null,
      };
      identities.set(key, identity);
    }
    return identity;
  };
  const rowIdentities = new Map<number, FileIdentity[]>();
  for (const row of contactRows) {
    const ids: FileIdentity[] = [];
    for (const slot of row.owners) {
      const id = identityFor(slot, row);
      bump(id.names, slot.name);
      if (slot.email) {
        const e = id.emails.get(slot.email.address) ?? { usable: slot.email.usable, count: 0, problem: slot.email.problem };
        e.count++;
        id.emails.set(slot.email.address, e);
      }
      if (slot.phone) {
        const p = id.phones.get(slot.phone.number) ?? { usable: slot.phone.usable, count: 0 };
        p.count++;
        id.phones.set(slot.phone.number, p);
      }
      if (slot.address) bump(id.addresses, slot.address);
      id.units.add(row.unitKey);
      id.unitLabels.add(row.unitLabel);
      id.lines.push(row.line);
      if (row.flags.doNotContact && row.notes) id.dncNotes.push(row.notes);
      if (row.flags.deceased && row.notes) id.deceasedNotes.push(row.notes);
      ids.push(id);
    }
    rowIdentities.set(row.line, ids);
  }

  // ---- 4. Match people to existing owners ----
  const unitByKey = new Map<string, Snapshot["units"][number]>();
  for (const u of snapshot.units) {
    const dev = snapshot.developments.find((d) => d.id === u.developmentId)!;
    const client = snapshot.clients.find((c) => c.id === dev.clientId)!;
    unitByKey.set(`${placeKey(client.name)}|${placeKey(dev.name)}|${u.unitRef.toUpperCase()}`, u);
  }
  const ownerById = new Map(snapshot.owners.map((o) => [o.id, o]));
  const identityOwner = new Map(snapshot.identities.map((i) => [`${i.nameKey}\u0000${i.emailKey}`, i.ownerId]));
  const matchNotes = new Map<string, string>();
  for (const id of identities.values()) {
    const exact = identityOwner.get(id.key);
    if (exact && ownerById.has(exact)) {
      id.existingOwnerId = exact;
      continue;
    }
    // A newer export can change someone's email. The same name on a unit they
    // already own is the same person; anything looser is only a suggestion.
    for (const uk of id.units) {
      const unit = unitByKey.get(uk);
      const match = unit?.activeOwnerIds
        .map((oid) => ownerById.get(oid))
        .find((o) => o && nameKey(o.fullName) === id.nameKey);
      if (match) {
        id.existingOwnerId = match.id;
        matchNotes.set(id.key, `matched to existing owner ${match.fullName} by name on ${[...id.unitLabels].join(", ")}`);
        break;
      }
    }
  }

  // ---- 5. Possible duplicates for staff to confirm (rule 2) ----
  const byLoose = new Map<string, FileIdentity[]>();
  for (const id of identities.values()) {
    if (!byLoose.has(id.looseKey)) byLoose.set(id.looseKey, []);
    byLoose.get(id.looseKey)!.push(id);
  }
  const mergeSuggestions: MergeSuggestion[] = [];
  const mergedInto = new Map<string, string>(); // identity key -> target ref
  for (const [looseKey, group] of byLoose) {
    const newOnes = group.filter((g) => !g.existingOwnerId);
    if (newOnes.length === 0) continue;
    const matchedOwnerIds = new Set(group.map((g) => g.existingOwnerId).filter(Boolean) as string[]);
    const otherExisting = snapshot.owners.filter(
      (o) => looseNameKey(o.fullName) === looseKey && !matchedOwnerIds.has(o.id),
    );
    const existingTargets = new Set([...matchedOwnerIds, ...otherExisting.map((o) => o.id)]);
    if (existingTargets.size > 1) continue; // merging two existing owners is out of scope
    const targetCount = newOnes.length + existingTargets.size;
    if (targetCount < 2) continue;

    const members: MergeMember[] = [];
    const existingId = [...existingTargets][0] ?? null;
    if (existingId) {
      const o = ownerById.get(existingId)!;
      const units = snapshot.units.filter((u) => u.activeOwnerIds.includes(o.id)).map((u) => u.unitRef);
      const fileIds = group.filter((g) => g.existingOwnerId === existingId);
      members.push({
        key: `owner:${o.id}`,
        name: o.fullName,
        email: o.email,
        units: [...new Set([...units, ...fileIds.flatMap((f) => [...f.unitLabels])])],
        lines: fileIds.flatMap((f) => f.lines),
        existingOwnerId: o.id,
      });
    }
    for (const id of newOnes) {
      members.push({
        key: id.key,
        name: mostCommon(id.names)!,
        email: id.emails.size ? [...id.emails.keys()][0] : null,
        units: [...id.unitLabels],
        lines: id.lines,
        existingOwnerId: null,
      });
    }
    const reasons = ["same name"];
    const allUnits = group.map((g) => g.units);
    const shared = [...allUnits[0]].filter((u) => allUnits.slice(1).some((s) => s.has(u)));
    if (shared.length) reasons.push("on the same unit");
    const emails = new Set(members.map((m) => m.email).filter(Boolean));
    if (emails.size > 1) reasons.push("different emails");
    if (members.some((m) => !m.email)) reasons.push("one has no email");
    if (existingId) reasons.push("one is already in Levyline");

    const id = `merge:${looseKey}`;
    const decision = decisions.merges[id] ?? null;
    mergeSuggestions.push({ id, reasons, members, decision });
    if (decision === "merge") {
      const target = existingId ? `existing:${existingId}` : `new:${newOnes[0].key}`;
      for (const n of newOnes) mergedInto.set(n.key, target);
    }
  }

  const targetOf = (id: FileIdentity) =>
    mergedInto.get(id.key) ?? (id.existingOwnerId ? `existing:${id.existingOwnerId}` : `new:${id.key}`);

  // ---- 6. Owners ----
  const targets = new Map<string, FileIdentity[]>();
  for (const id of identities.values()) {
    const t = targetOf(id);
    if (!targets.has(t)) targets.set(t, []);
    targets.get(t)!.push(id);
  }
  const emailUsers = new Map<string, Set<string>>(); // email -> loose names using it
  for (const id of identities.values()) {
    for (const e of id.emails.keys()) {
      if (!emailUsers.has(e)) emailUsers.set(e, new Set());
      emailUsers.get(e)!.add(id.looseKey);
    }
  }

  const owners: OwnerPlan[] = [];
  for (const [ref, ids] of targets) {
    const existingId = ref.startsWith("existing:") ? ref.slice(9) : null;
    const existing = existingId ? ownerById.get(existingId)! : null;
    const names = new Map<string, number>();
    const emails = new Map<string, { usable: boolean; count: number; problem?: string }>();
    const phones = new Map<string, { usable: boolean; count: number }>();
    const addresses = new Map<string, number>();
    for (const id of ids) {
      for (const [k, v] of id.names) names.set(k, (names.get(k) ?? 0) + v);
      for (const [k, v] of id.emails) {
        const e = emails.get(k) ?? { ...v, count: 0 };
        e.count += v.count;
        emails.set(k, e);
      }
      for (const [k, v] of id.phones) {
        const p = phones.get(k) ?? { ...v, count: 0 };
        p.count += v.count;
        phones.set(k, p);
      }
      for (const [k, v] of id.addresses) addresses.set(k, (addresses.get(k) ?? 0) + v);
    }
    const ownLoose = ids[0].looseKey;
    const warningsForOwner: string[] = [];
    const lines = [...new Set(ids.flatMap((i) => i.lines))].sort((a, b) => a - b);
    const fullName = mostCommon(names)!;

    // Email: a usable one, preferably not shared with someone of another name.
    const emailScore = ([addr, v]: [string, { usable: boolean; count: number }]) =>
      (v.usable ? 1000 : 0) + ((emailUsers.get(addr)?.size ?? 1) > 1 ? 0 : 100) + v.count;
    const emailChoices = [...emails.entries()].sort((a, b) => emailScore(b) - emailScore(a));
    const email = emailChoices[0]?.[0] ?? null;
    if (emailChoices.length > 1) {
      warningsForOwner.push(
        `more than one email in the file (${emailChoices.map((e) => e[0]).join(", ")}); using ${email}`,
      );
    }
    if (email && !emailChoices[0][1].usable) warningsForOwner.push(emailChoices[0][1].problem ?? `email ${email} is not usable`);
    if (!email) warningsForOwner.push("no email address in the file");
    if (email) {
      const sharers = [...(emailUsers.get(email) ?? [])].filter((l) => l !== ownLoose);
      if (sharers.length) {
        const others = [...identities.values()]
          .filter((i) => sharers.includes(i.looseKey))
          .map((i) => mostCommon(i.names));
        warningsForOwner.push(`shares ${email} with ${[...new Set(others)].join(", ")}; not merged, because people share inboxes`);
      }
    }

    const phoneScore = (p: [string, { usable: boolean; count: number }]) => (p[1].usable ? 1000 : 0) + p[1].count;
    const phoneChoices = [...phones.entries()].sort((a, b) => phoneScore(b) - phoneScore(a));
    const phone = phoneChoices[0]?.[0] ?? null;
    if (phoneChoices.length > 1) {
      warningsForOwner.push(`more than one phone in the file (${phoneChoices.map((p) => p[0]).join(", ")}); using ${phone}`);
    }
    const address = mostCommon(addresses);
    if (addresses.size > 1) warningsForOwner.push(`more than one correspondence address in the file; using ${address}`);

    const dncNotes = [...new Set(ids.flatMap((i) => i.dncNotes))];
    const deceasedNotes = [...new Set(ids.flatMap((i) => i.deceasedNotes))];
    for (const id of ids) {
      const note = matchNotes.get(id.key);
      if (note) warningsForOwner.push(note);
    }

    const fileValues = {
      fullName,
      email,
      phone,
      address,
      doNotContact: dncNotes.length > 0,
      doNotContactReason: dncNotes.join("; ") || null,
      deceased: deceasedNotes.length > 0,
      deceasedNote: deceasedNotes.join("; ") || null,
    };

    const changes: Change[] = [];
    const imported: Record<string, unknown> = { ...fileValues };
    let values: OwnerValues;
    if (!existing) {
      values = fileValues;
    } else {
      // A field only changes when the file's value differs from what the
      // last import wrote; otherwise a staff edit stands.
      const prev = existing.imported;
      // Values that tie for the file's best choice for each field.
      const top = <T,>(list: T[], score: (x: T) => number, key: (x: T) => string) =>
        list.filter((x) => score(x) === score(list[0])).map(key);
      const byCount = (m: Map<string, number>) =>
        top([...m.entries()].sort((a, b) => b[1] - a[1]), (x) => x[1], (x) => x[0]);
      const seen: Record<string, string[]> = {
        fullName: byCount(names),
        email: emailChoices.length ? top(emailChoices, emailScore, (x) => x[0]) : [],
        phone: phoneChoices.length ? top(phoneChoices, phoneScore, (x) => x[0]) : [],
        address: byCount(addresses),
      };
      const pick = <K extends "fullName" | "email" | "phone" | "address">(field: K, current: string | null) => {
        const next = fileValues[field];
        // No value in this file (e.g. the row that carried it has gone): no
        // information, so never blank the field.
        if (next === null) {
          imported[field] = prev[field] ?? null;
          return current;
        }
        // The file offers several equally good values and one is what we have: keep it.
        if (current !== null && seen[field].includes(current)) {
          imported[field] = current;
          return current;
        }
        if (str(prev[field]) !== str(next) && str(current) !== str(next)) {
          changes.push({ field, from: current, to: next });
          return next;
        }
        return current;
      };
      values = {
        fullName: pick("fullName", existing.fullName) ?? existing.fullName,
        email: pick("email", existing.email),
        phone: pick("phone", existing.phone),
        address: pick("address", existing.address),
        // Safety flags are only ever added by an import, never removed:
        // clearing them is a staff decision, and it survives a re-import of
        // a file that still carries the same note.
        doNotContact: existing.doNotContact,
        doNotContactReason: null,
        deceased: existing.deceased,
        deceasedNote: null,
      };
      if (fileValues.doNotContact && !prev.doNotContact && !existing.doNotContact) {
        values.doNotContact = true;
        values.doNotContactReason = fileValues.doNotContactReason;
        changes.push({ field: "doNotContact", from: "no", to: "yes" });
      }
      if (fileValues.deceased && !prev.deceased && !existing.deceased) {
        values.deceased = true;
        values.deceasedNote = fileValues.deceasedNote;
        changes.push({ field: "deceased", from: "no", to: "yes" });
      }
    }

    const knownIdentities = new Set(
      snapshot.identities.filter((i) => i.ownerId === existingId).map((i) => `${i.nameKey}\u0000${i.emailKey}`),
    );
    const newIdentities = ids.filter((i) => !knownIdentities.has(i.key));
    const identityChanged = newIdentities.length > 0;
    owners.push({
      ref,
      existingId,
      status: !existing ? "create" : changes.length || identityChanged ? "update" : "unchanged",
      values,
      imported,
      changes,
      identities: newIdentities.map((i) => ({ nameKey: i.nameKey, emailKey: i.emailKey })),
      emailUsable: isUsableEmail(values.email),
      warnings: warningsForOwner,
      lines,
    });
  }

  // ---- 7. Units and who owns them ----
  const unitRows = new Map<string, Row[]>();
  for (const row of contactRows) {
    if (!unitRows.has(row.unitKey)) unitRows.set(row.unitKey, []);
    unitRows.get(row.unitKey)!.push(row);
  }
  const units: UnitPlan[] = [];
  for (const [key, list] of unitRows) {
    const first = list[0];
    const existing = unitByKey.get(key) ?? null;
    const ownerRefs = new Set<string>();
    const soldOwnerRefs = new Set<string>();
    for (const row of list) {
      for (const id of rowIdentities.get(row.line) ?? []) {
        ownerRefs.add(targetOf(id));
        if (row.flags.sold) soldOwnerRefs.add(targetOf(id));
      }
    }
    const blocks = new Map<string, number>();
    for (const r of list) if (r.block) bump(blocks, r.block);
    const block = mostCommon(blocks);
    const active = new Set(existing?.activeOwnerIds ?? []);
    const refsAsIds = new Set([...ownerRefs].filter((r) => r.startsWith("existing:")).map((r) => r.slice(9)));
    const addedOwnerRefs = [...ownerRefs].filter((r) => !(r.startsWith("existing:") && active.has(r.slice(9))));
    const removedOwnerIds = [...active].filter((id) => !refsAsIds.has(id));
    const unarchive = Boolean(existing?.archived);
    const changed = !existing || addedOwnerRefs.length > 0 || removedOwnerIds.length > 0 || unarchive || (existing.block ?? null) !== block;
    units.push({
      key,
      label: first.unitLabel,
      clientName: first.clientName,
      developmentName: first.developmentName,
      unitRef: first.unitRef,
      block,
      existingId: existing?.id ?? null,
      status: !existing ? "create" : changed ? "update" : "unchanged",
      ownerRefs: [...ownerRefs],
      soldOwnerRefs: [...soldOwnerRefs],
      soldNote: list.find((r) => r.flags.sold)?.notes ?? null,
      addedOwnerRefs,
      removedOwnerIds,
      unarchive,
    });
    for (const removed of removedOwnerIds) {
      warnings.push({ text: `${ownerById.get(removed)?.fullName ?? "An owner"} is no longer listed on ${first.unitLabel}; they will be removed from it` });
    }
  }

  // ---- 8. Receivables ----
  const recByKey = new Map(
    snapshot.receivables.map((r) => {
      const client = snapshot.clients.find((c) => c.id === r.clientId)!;
      return [`${placeKey(client.name)}|${r.demandRef}`, r];
    }),
  );
  const receivables: ReceivablePlan[] = [];
  for (const row of keptRows) {
    if (skipped.some((s) => s.line === row.line)) continue;
    const key = `${placeKey(row.clientName)}|${row.demandRef}`;
    const existing = recByKey.get(key) ?? null;
    const values: ReceivableValues = {
      kind: row.kind,
      period: row.period,
      amountCents: row.amountCents,
      paidCents: row.paidCents,
      dueDate: row.dueDate,
      notes: row.notes,
      unitKey: row.unitKey,
    };
    const changes: Change[] = [];
    if (existing) {
      const prev = existing.imported;
      for (const field of ["kind", "period", "amountCents", "paidCents", "dueDate", "notes", "unitKey"] as const) {
        if (str(prev[field]) !== str(values[field])) {
          const fmt = (v: unknown) =>
            v === null || v === undefined ? null : field.endsWith("Cents") ? formatCents(Number(v)) : String(v);
          changes.push({ field, from: fmt(prev[field]), to: fmt(values[field]) });
        }
      }
    }
    const setDisputed = row.flags.disputed && !(existing?.imported.disputed === true) && !existing?.disputed ? row.notes : null;
    if (setDisputed && existing) changes.push({ field: "disputed", from: "no", to: "yes" });
    receivables.push({
      clientName: row.clientName,
      demandRef: row.demandRef,
      existingId: existing?.id ?? null,
      status: !existing ? "create" : changes.length ? "update" : "unchanged",
      values,
      setDisputed,
      imported: { ...values, disputed: row.flags.disputed || existing?.imported.disputed === true },
      changes,
      line: row.line,
    });
  }

  // ---- 9. Units that have gone from the export ----
  const missingUnits: MissingUnit[] = [];
  for (const [key, unit] of unitByKey) {
    if (unit.archived) continue;
    const clientKey = key.split("|")[0];
    if (!clientKeysInFile.has(clientKey) || unitKeysInFile.has(key)) continue;
    const dev = snapshot.developments.find((d) => d.id === unit.developmentId)!;
    const ownerNames = unit.activeOwnerIds.map((id) => ownerById.get(id)?.fullName).filter(Boolean);
    missingUnits.push({
      id: unit.id,
      label: `${unit.unitRef} · ${dev.name}${ownerNames.length ? ` (${ownerNames.join(", ")})` : ""}`,
      archive: decisions.archiveUnitIds.includes(unit.id),
    });
  }

  const count = <S extends string>(list: { status: S }[], keys: S[]) =>
    Object.fromEntries(keys.map((k) => [k, list.filter((l) => l.status === k).length])) as Record<S, number>;
  skipped.sort((a, b) => a.line - b.line);
  const skippedLines = new Set(skipped.map((s) => s.line));
  // Reformatting phone numbers is routine: one summary line, not one per row.
  const phoneTidies = tidied.filter((t) => t.text.startsWith("phone ") && !skippedLines.has(t.line!));
  const tidiedNotes = tidied.filter((t) => !t.text.startsWith("phone ") && !skippedLines.has(t.line!));
  if (phoneTidies.length) {
    tidiedNotes.push({ text: `${phoneTidies.length} phone numbers written in +353 format (e.g. ${phoneTidies[0].text.replace(/^phone /, "")})` });
  }
  tidiedNotes.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return {
    headers,
    rowCount: dataRows.length,
    dateFormat: { detected: detected.order, evidence: detected.evidence, conflicting: detected.conflicting, used: dateOrder },
    skipped,
    tidied: tidiedNotes,
    warnings,
    mergeSuggestions,
    owners,
    units,
    receivables,
    missingUnits,
    ready: mergeSuggestions.every((m) => m.decision !== null),
    counts: {
      owners: count(owners, ["create", "update", "unchanged"]),
      units: count(units, ["create", "update", "unchanged"]),
      receivables: count(receivables, ["create", "update", "unchanged"]),
      skipped: skipped.length,
      noUsableEmail: owners.filter((o) => !o.emailUsable).length,
    },
  };
}

export function isUsableEmail(email: string | null | undefined): boolean {
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));
}

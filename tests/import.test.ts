import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/lib/db";
import { commitImport, previewImport } from "@/lib/import/run";

import { csv, decisions, mappingFor, resetDb } from "./helpers";

const first = csv("owners-and-receivables.csv");
const update = csv("owners-and-receivables-update.csv");
const mapping = mappingFor(first);

async function counts() {
  const { rows } = await pool.query(
    `select (select count(*) from owners)::int as owners, (select count(*) from units)::int as units,
            (select count(*) from receivables)::int as receivables`,
  );
  return rows[0];
}

async function importFirst(merges: Record<string, "merge" | "separate"> = {}) {
  const preview = await previewImport(first, mapping, decisions());
  const all = Object.fromEntries(preview.mergeSuggestions.map((m) => [m.id, merges[m.id] ?? "merge"]));
  return commitImport("first.csv", first, mapping, decisions({ merges: all }));
}

describe("import", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("refuses to import until every possible duplicate has a decision", async () => {
    await expect(commitImport("first.csv", first, mapping, decisions())).rejects.toThrow(/decision/);
    expect((await counts()).owners).toBe(0);
  });

  it("never guesses numbers or dates (rule 1)", async () => {
    const plan = await previewImport(first, mapping, decisions());
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.demandRef, s.reasons.join(" ")]));
    expect(reasons["D-1021"]).toMatch(/1\.340,00/);
    expect(reasons["D-1161"]).toMatch(/not a number/);
    expect(reasons["D-1182"]).toMatch(/not a real date/);
    expect(reasons["D-1049"]).toMatch(/different amount/);
    expect(reasons["D-1133"]).toMatch(/unit ref is blank/);

    // Without a confirmed date order, day/month-swappable dates aren't read at all.
    const unsure = await previewImport(first, mapping, decisions({ dateOrder: null }));
    expect(unsure.skipped.find((s) => s.demandRef === "D-1273")?.reasons[0]).toMatch(/could be/);
  });

  it("suggests, but never silently makes, merges; a shared email is not a merge (rule 2)", async () => {
    const plan = await previewImport(first, mapping, decisions());
    expect(plan.mergeSuggestions.map((m) => m.members.map((x) => x.name))).toContainEqual(["Declan Kennedy", "Declan Kennedy"]);
    const liam = plan.owners.find((o) => o.values.fullName === "Liam Gallagher")!;
    const una = plan.owners.find((o) => o.values.fullName === "Úna Daly")!;
    expect(liam.ref).not.toBe(una.ref);
    expect(liam.warnings.join()).toMatch(/shares/);
  });

  it("keeps separate people separate when staff say so", async () => {
    const preview = await previewImport(first, mapping, decisions());
    const declan = preview.mergeSuggestions[0].id;
    await importFirst({ [declan]: "separate" });
    const { rows } = await pool.query("select count(*)::int as n from owners where full_name = 'Declan Kennedy'");
    expect(rows[0].n).toBe(2);
    // ...and doesn't ask again next time.
    const again = await previewImport(first, mapping, decisions());
    expect(again.mergeSuggestions).toHaveLength(0);
  });

  it("is idempotent: the same file twice creates nothing new (rule 3)", async () => {
    await importFirst();
    const before = await counts();
    const again = await previewImport(first, mapping, decisions());
    expect(again.counts.owners.create).toBe(0);
    expect(again.counts.units.create).toBe(0);
    expect(again.counts.receivables.create).toBe(0);
    expect(again.counts.receivables.update).toBe(0);
    await commitImport("first.csv", first, mapping, decisions());
    expect(await counts()).toEqual(before);
  });

  it("keeps notes that change what staff can do (rule 4)", async () => {
    await importFirst();
    const { rows } = await pool.query(
      `select full_name, do_not_contact, deceased from owners where do_not_contact or deceased order by full_name`,
    );
    expect(rows).toEqual([
      { full_name: "Eoin Fitzgerald", do_not_contact: true, deceased: false },
      { full_name: "Róisín Ní Bhriain", do_not_contact: false, deceased: true },
    ]);
    const disputed = await pool.query("select demand_ref from receivables where disputed");
    expect(disputed.rows.map((r) => r.demand_ref)).toEqual(["D-1091"]);
    const sold = await pool.query("select sold_note from unit_owners where sold_note is not null");
    expect(sold.rows[0].sold_note).toMatch(/sold/);
  });

  it("updates from a corrected file without duplicating, and keeps staff edits", async () => {
    await importFirst();
    // A staff member corrects Pádraig's email and clears a dispute.
    await pool.query("update owners set email = 'padraig@staff-fixed.example.com' where full_name = 'Pádraig Murphy'");
    await pool.query("update owners set phone = '+353 1 555 0000' where full_name = 'Emer Power'");

    const plan = await previewImport(update, mapping, decisions());
    expect(plan.mergeSuggestions).toHaveLength(0);
    expect(plan.missingUnits.map((u) => u.label)).toEqual([expect.stringContaining("MI-106")]);
    const deirdre = plan.owners.find((o) => o.values.fullName === "Deirdre Dunne")!;
    expect(deirdre.changes).toContainEqual({ field: "email", from: "deirdre.dunne23@example.com", to: "deirdre.dunne.home@example.com" });

    await commitImport("update.csv", update, mapping, decisions({ archiveUnitIds: plan.missingUnits.map((u) => u.id) }));

    const owner = async (name: string) =>
      (await pool.query("select * from owners where full_name = $1", [name])).rows;
    expect(await owner("Deirdre Dunne")).toHaveLength(1);
    expect((await owner("Deirdre Dunne"))[0].email).toBe("deirdre.dunne.home@example.com");
    // The file changed Pádraig's email (it fixed the typo), so the file wins.
    expect((await owner("Pádraig Murphy"))[0].email).toBe("padraig.murphy6@example.com");
    // The file didn't change Emer's phone, so the staff edit survives.
    expect((await owner("Emer Power"))[0].phone).toBe("+353 1 555 0000");

    // A unit leaving the file doesn't blank the contact details its rows carried.
    expect((await owner("Declan Kennedy"))[0].email).toBe("declan.kennedy28@example.com");
    // Úna moves off the email she shared with Liam Gallagher, onto her own.
    expect((await owner("Úna Daly"))[0].email).toBe("una.daly17@example.com");
    // Two equally likely addresses in the file: keep the one we already have.
    expect((await owner("Clodagh Brennan"))[0].address).toMatch(/London/);

    const paid = await pool.query("select paid from receivables where demand_ref = 'D-1273'");
    expect(paid.rows[0].paid).toBe("1150.00");
    const n04 = await pool.query(
      `select o.full_name, uo.active from unit_owners uo join owners o on o.id = uo.owner_id
         join units u on u.id = uo.unit_id where u.unit_ref = 'RI-N04' order by o.full_name`,
    );
    expect(n04.rows).toEqual([
      { full_name: "Cathal Lynch", active: false },
      { full_name: "Ruth Delaney", active: true },
    ]);
    const archived = await pool.query("select unit_ref from units where archived_at is not null");
    expect(archived.rows.map((r) => r.unit_ref)).toEqual(["MI-106"]);

    // Importing the update again changes nothing.
    const again = await previewImport(update, mapping, decisions());
    expect(again.counts.owners.create + again.counts.owners.update).toBe(0);
    expect(again.counts.receivables.create + again.counts.receivables.update).toBe(0);
  });
});

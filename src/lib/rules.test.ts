import { describe, expect, it } from "vitest";

import { automatedEmailVerdict, isMissed, validateCommitment, type OwnerFacts, type ReceivableFacts } from "./rules";
import { inContactHours, nextContactWindow } from "./time";

const owner: OwnerFacts = {
  doNotContact: false,
  deceased: false,
  automationPaused: false,
  automationPausedReason: null,
  emailUsable: true,
};
const rec = (over: Partial<ReceivableFacts> = {}): ReceivableFacts => ({
  id: "r1",
  clientId: "c1",
  demandRef: "D-1",
  outstandingCents: 100_00,
  dueDate: "2026-10-01",
  disputed: false,
  inActiveCommitment: false,
  soldByOwner: false,
  ...over,
});
// Tuesday 1 December 2026, 10:00 in Dublin (UTC+0 in winter).
const tuesdayMorning = new Date("2026-12-01T10:00:00Z");

describe("contact hours (rule 9)", () => {
  it("is Monday to Saturday, 08:00 to 20:00 Irish time", () => {
    expect(inContactHours(new Date("2026-12-01T07:59:00Z"))).toBe(false);
    expect(inContactHours(new Date("2026-12-01T08:00:00Z"))).toBe(true);
    expect(inContactHours(new Date("2026-12-01T19:59:00Z"))).toBe(true);
    expect(inContactHours(new Date("2026-12-01T20:00:00Z"))).toBe(false);
    expect(inContactHours(new Date("2026-12-05T12:00:00Z"))).toBe(true); // Saturday
    expect(inContactHours(new Date("2026-12-06T12:00:00Z"))).toBe(false); // Sunday
  });
  it("uses Irish summer time", () => {
    // 07:30 UTC in July is 08:30 in Dublin.
    expect(inContactHours(new Date("2026-07-01T07:30:00Z"))).toBe(true);
    expect(inContactHours(new Date("2026-07-01T19:30:00Z"))).toBe(false);
  });
  it("finds the next window, skipping Sunday", () => {
    expect(nextContactWindow(new Date("2026-12-05T21:00:00Z")).toISOString()).toBe("2026-12-07T08:00:00.000Z");
  });
});

describe("automatedEmailVerdict", () => {
  const verdict = (o: Partial<OwnerFacts>, receivables = [rec()], now = tuesdayMorning, alreadyEmailedToday = false) =>
    automatedEmailVerdict({ owner: { ...owner, ...o }, receivables, now, alreadyEmailedToday });

  it("emails a normal overdue owner", () => {
    expect(verdict({})).toMatchObject({ ok: true, balanceCents: 100_00 });
  });
  it("never emails do not contact (rule 5, 8)", () => {
    expect(verdict({ doNotContact: true })).toMatchObject({ ok: false, reason: "Do not contact" });
  });
  it("never emails a zero or credit balance (rule 8)", () => {
    expect(verdict({}, [rec(), rec({ id: "r2", outstandingCents: -100_00 })])).toMatchObject({ ok: false });
  });
  it("never chases disputed or not-yet-due receivables (rule 8)", () => {
    expect(verdict({}, [rec({ disputed: true })])).toMatchObject({ ok: false, reason: expect.stringMatching(/disputed/) });
    expect(verdict({}, [rec({ dueDate: "2026-12-02" })])).toMatchObject({ ok: false, reason: expect.stringMatching(/not due/) });
    // Only the chaseable part goes in the email.
    const mixed = verdict({}, [rec(), rec({ id: "r2", disputed: true, outstandingCents: 500_00 })]);
    expect(mixed).toMatchObject({ ok: true, balanceCents: 100_00 });
  });
  it("doesn't chase receivables under an active commitment (rule 14)", () => {
    expect(verdict({}, [rec({ inActiveCommitment: true })])).toMatchObject({ ok: false });
    expect(verdict({}, [rec({ inActiveCommitment: true }), rec({ id: "r2" })])).toMatchObject({ ok: true, chase: [expect.objectContaining({ id: "r2" })] });
  });
  it("waits for contact hours and for tomorrow (rule 9)", () => {
    const sunday = verdict({}, [rec()], new Date("2026-12-06T12:00:00Z"));
    expect(sunday).toMatchObject({ ok: false, retryAt: new Date("2026-12-07T08:00:00Z") });
    const second = verdict({}, [rec()], tuesdayMorning, true);
    expect(second).toMatchObject({ ok: false, retryAt: new Date("2026-12-02T08:00:00Z") });
  });
  it("stops after a reply until staff resume (rule 10)", () => {
    expect(verdict({ automationPaused: true, automationPausedReason: "Owner replied" })).toMatchObject({ ok: false });
  });
});

describe("validateCommitment (rules 11 to 13)", () => {
  const today = "2026-12-01";
  const receivables = [rec(), rec({ id: "r2", clientId: "c2" })];
  const check = (instalments: { dueDate: string; amountCents: number }[], receivableIds = ["r1"], active = false) =>
    validateCommitment({ draft: { clientId: "c1", receivableIds, instalments }, receivables, hasActiveCommitmentForClient: active, today });

  it("accepts a valid plan", () => {
    expect(check([{ dueDate: "2026-12-10", amountCents: 50_00 }, { dueDate: "2027-01-10", amountCents: 50_00 }])).toEqual([]);
  });
  it("rejects more than outstanding, past or unordered dates, and a late first payment", () => {
    expect(check([{ dueDate: "2026-12-10", amountCents: 100_01 }])).toContainEqual(expect.stringMatching(/more than is outstanding/));
    expect(check([{ dueDate: "2026-12-01", amountCents: 10_00 }])).toContainEqual(expect.stringMatching(/future/));
    expect(check([{ dueDate: "2026-12-10", amountCents: 10_00 }, { dueDate: "2026-12-09", amountCents: 10_00 }])).toContainEqual(expect.stringMatching(/after payment 1/));
    expect(check([{ dueDate: "2027-01-01", amountCents: 10_00 }])).toContainEqual(expect.stringMatching(/30 days/));
  });
  it("rejects mixed clients, more than 12 payments and a second active commitment", () => {
    expect(check([{ dueDate: "2026-12-10", amountCents: 10_00 }], ["r1", "r2"])).toContainEqual(expect.stringMatching(/same client/));
    const many = Array.from({ length: 13 }, (_, i) => ({ dueDate: `2026-12-${String(i + 2).padStart(2, "0")}`, amountCents: 1_00 }));
    expect(check(many)).toContainEqual(expect.stringMatching(/between 1 and 12/));
    expect(check([{ dueDate: "2026-12-10", amountCents: 10_00 }], ["r1"], true)).toContainEqual(expect.stringMatching(/already has an active/));
  });
});

describe("missed instalments (rule 15)", () => {
  it("is missed 3 days after its date", () => {
    expect(isMissed({ dueDate: "2026-12-01", paid: false }, "2026-12-03")).toBe(false);
    expect(isMissed({ dueDate: "2026-12-01", paid: false }, "2026-12-04")).toBe(true);
    expect(isMissed({ dueDate: "2026-12-01", paid: true }, "2026-12-10")).toBe(false);
  });
});

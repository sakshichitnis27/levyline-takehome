// The product rules that decide who may be emailed and what a commitment may
// be. Pure functions over plain data, so they're easy to test and the same
// checks run in the UI, the API and the automation worker.

import { addDays, daysBetween, inContactHours, irishDate, nextContactWindow, startOfNextIrishDay } from "@/lib/time";

export type ReceivableFacts = {
  id: string;
  clientId: string;
  demandRef: string;
  outstandingCents: number; // amount - paid; negative for credits
  dueDate: string;
  disputed: boolean;
  inActiveCommitment: boolean;
  soldByOwner: boolean; // the file said this owner sold the unit
};

export type OwnerFacts = {
  doNotContact: boolean;
  deceased: boolean;
  automationPaused: boolean;
  automationPausedReason: string | null;
  emailUsable: boolean;
};

export type Verdict<R extends ReceivableFacts = ReceivableFacts> =
  | { ok: true; chase: R[]; balanceCents: number }
  | { ok: false; reason: string; retryAt: Date | null };

/** Rule 8 and 14: the receivables an automation may chase today. */
export function chaseable<R extends ReceivableFacts>(receivables: R[], today: string): R[] {
  return receivables.filter(
    (r) => r.outstandingCents > 0 && !r.disputed && r.dueDate <= today && !r.inActiveCommitment && !r.soldByOwner,
  );
}

/**
 * Whether an automation may email this owner now about one client's
 * receivables, and if not, why and when to look again. Rules 5, 8, 9, 10, 14.
 */
export function automatedEmailVerdict<R extends ReceivableFacts>(input: {
  owner: OwnerFacts;
  receivables: R[]; // this owner's receivables for the automation's client
  now: Date;
  alreadyEmailedToday: boolean;
}): Verdict<R> {
  const { owner, receivables, now } = input;
  const today = irishDate(now);
  if (owner.doNotContact) return { ok: false, reason: "Do not contact", retryAt: null };
  if (owner.deceased) return { ok: false, reason: "Owner is recorded as deceased", retryAt: null };
  if (!owner.emailUsable) return { ok: false, reason: "No usable email address", retryAt: null };
  if (owner.automationPaused) {
    return { ok: false, reason: `Automation paused${owner.automationPausedReason ? `: ${owner.automationPausedReason}` : ""}`, retryAt: null };
  }
  const balanceCents = receivables.reduce((sum, r) => sum + r.outstandingCents, 0);
  if (balanceCents <= 0) return { ok: false, reason: "Balance is zero or in credit", retryAt: null };

  const chase = chaseable(receivables, today);
  if (chase.length === 0) {
    const why = [
      receivables.some((r) => r.disputed && r.outstandingCents > 0) && "disputed",
      receivables.some((r) => r.dueDate > today && r.outstandingCents > 0) && "not due yet",
      receivables.some((r) => r.inActiveCommitment && r.outstandingCents > 0) && "covered by an active commitment",
      receivables.some((r) => r.soldByOwner && r.outstandingCents > 0) && "on a unit the owner sold",
    ].filter(Boolean);
    return { ok: false, reason: `Nothing to chase: everything owed is ${why.join(" or ") || "settled"}`, retryAt: null };
  }
  if (!inContactHours(now)) {
    return { ok: false, reason: "Outside contact hours (Mon–Sat, 08:00–20:00 Irish time)", retryAt: nextContactWindow(now) };
  }
  if (input.alreadyEmailedToday) {
    return { ok: false, reason: "Already had an automated email today", retryAt: nextContactWindow(startOfNextIrishDay(now)) };
  }
  const chaseCents = chase.reduce((sum, r) => sum + r.outstandingCents, 0);
  return { ok: true, chase, balanceCents: Math.min(chaseCents, balanceCents) };
}

// ---------- Commitments (rules 11 to 13) ----------

export type CommitmentDraft = {
  clientId: string;
  receivableIds: string[];
  instalments: { dueDate: string; amountCents: number }[];
};

export function validateCommitment(input: {
  draft: CommitmentDraft;
  receivables: ReceivableFacts[]; // the owner's receivables, all clients
  hasActiveCommitmentForClient: boolean;
  today: string;
}): string[] {
  const { draft, receivables, today } = input;
  const errors: string[] = [];
  const chosen = draft.receivableIds.map((id) => receivables.find((r) => r.id === id));
  if (draft.receivableIds.length === 0) errors.push("Choose at least one receivable");
  if (chosen.some((r) => !r)) errors.push("A chosen receivable isn't one of this owner's");
  const found = chosen.filter(Boolean) as ReceivableFacts[];
  if (found.some((r) => r.clientId !== draft.clientId)) errors.push("All receivables must be for the same client");
  if (found.some((r) => r.inActiveCommitment)) errors.push("A chosen receivable is already covered by an active commitment");
  if (found.some((r) => r.outstandingCents <= 0)) errors.push("A chosen receivable has nothing outstanding");
  if (input.hasActiveCommitmentForClient) errors.push("This owner already has an active commitment with this client");

  const { instalments } = draft;
  if (instalments.length < 1 || instalments.length > 12) errors.push("A commitment has between 1 and 12 payments");
  if (instalments.some((i) => !Number.isInteger(i.amountCents) || i.amountCents <= 0)) {
    errors.push("Every payment must be more than €0");
  }
  const total = instalments.reduce((sum, i) => sum + i.amountCents, 0);
  const outstanding = found.reduce((sum, r) => sum + Math.max(0, r.outstandingCents), 0);
  if (total > outstanding) errors.push("The payments add up to more than is outstanding on the chosen receivables");
  instalments.forEach((i, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.dueDate)) errors.push(`Payment ${index + 1} needs a date`);
    else if (i.dueDate <= today) errors.push(`Payment ${index + 1} must be in the future`);
    if (index > 0 && i.dueDate <= instalments[index - 1].dueDate) {
      errors.push(`Payment ${index + 1} must be after payment ${index}`);
    }
  });
  if (instalments[0] && /^\d{4}-\d{2}-\d{2}$/.test(instalments[0].dueDate) && instalments[0].dueDate > addDays(today, 30)) {
    errors.push("The first payment must be within 30 days of today");
  }
  return [...new Set(errors)];
}

/** Rule 15: an instalment is missed once it's unpaid 3 days after its date. */
export const MISSED_AFTER_DAYS = 3;

export function isMissed(instalment: { dueDate: string; paid: boolean }, today: string): boolean {
  return !instalment.paid && daysBetween(instalment.dueDate, today) >= MISSED_AFTER_DAYS;
}

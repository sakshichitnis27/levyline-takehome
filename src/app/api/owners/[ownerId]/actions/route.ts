import { body, handle, HttpError } from "@/lib/api";
import { retryEnrollment, wakeOwner } from "@/lib/automation/engine";
import { cancelCommitment, markInstalmentPaid } from "@/lib/commitments";
import { pool } from "@/lib/db";
import { getOwner } from "@/lib/owners";
import { logEvent, one } from "@/lib/sql";

type Action =
  | { action: "dnc"; on: boolean; reason?: string }
  | { action: "automation"; paused: boolean; reason?: string }
  | { action: "dispute"; receivableId: string; on: boolean; reason?: string }
  | { action: "contact"; email: string; phone: string }
  | { action: "instalment"; instalmentId: string; paid: boolean }
  | { action: "cancel-commitment"; commitmentId: string }
  | { action: "retry-enrollment"; enrollmentId: string }
  | { action: "stop-enrollment"; enrollmentId: string };

export const POST = handle(async (request: Request, { params }: { params: Promise<{ ownerId: string }> }) => {
  const { ownerId } = await params;
  const owner = await getOwner(ownerId);
  if (!owner) throw new HttpError(404, "Owner not found");
  const a = await body<Action>(request);

  switch (a.action) {
    case "dnc":
      await pool.query("update owners set do_not_contact = $2, do_not_contact_reason = $3, updated_at = now() where id = $1", [
        ownerId,
        a.on,
        a.on ? a.reason?.trim() || "Set by staff" : null,
      ]);
      await logEvent(pool, ownerId, "status", a.on ? `Marked do not contact${a.reason ? `: ${a.reason}` : ""}` : "Do not contact cleared");
      break;
    case "automation":
      await pool.query("update owners set automation_paused = $2, automation_paused_reason = $3 where id = $1", [
        ownerId,
        a.paused,
        a.paused ? a.reason?.trim() || "Paused by staff" : null,
      ]);
      await logEvent(pool, ownerId, "automation", a.paused ? "Automated emails paused by staff" : "Automated emails resumed by staff");
      break;
    case "dispute": {
      const r = await one<{ demand_ref: string }>(
        `update receivables r set disputed = $3, dispute_reason = $4, updated_at = now()
          from unit_owners uo where r.id = $2 and uo.unit_id = r.unit_id and uo.owner_id = $1
          returning r.demand_ref`,
        [ownerId, a.receivableId, a.on, a.on ? a.reason?.trim() || "Disputed" : null],
      );
      if (!r) throw new HttpError(404, "Receivable not found");
      await logEvent(pool, ownerId, "status", a.on ? `${r.demand_ref} marked disputed${a.reason ? `: ${a.reason}` : ""}` : `${r.demand_ref} dispute resolved`);
      break;
    }
    case "contact": {
      const email = a.email.trim().toLowerCase() || null;
      const phone = a.phone.trim() || null;
      const changes = [
        email !== owner.email && `email ${owner.email ?? "(blank)"} → ${email ?? "(blank)"}`,
        phone !== owner.phone && `phone ${owner.phone ?? "(blank)"} → ${phone ?? "(blank)"}`,
      ].filter(Boolean);
      await pool.query("update owners set email = $2, phone = $3, updated_at = now() where id = $1", [ownerId, email, phone]);
      if (changes.length) await logEvent(pool, ownerId, "status", `Contact details edited: ${changes.join("; ")}`);
      break;
    }
    case "instalment":
      await markInstalmentPaid(ownerId, a.instalmentId, a.paid);
      break;
    case "cancel-commitment":
      await cancelCommitment(ownerId, a.commitmentId);
      break;
    case "retry-enrollment":
      if (!(await retryEnrollment(a.enrollmentId, ownerId))) throw new HttpError(409, "Nothing to retry");
      break;
    case "stop-enrollment": {
      const { rowCount } = await pool.query(
        "update enrollments set state = 'stopped', updated_at = now() where id = $1 and owner_id = $2 and state not in ('completed', 'stopped')",
        [a.enrollmentId, ownerId],
      );
      if (rowCount) await logEvent(pool, ownerId, "automation", "Removed from an automation by staff");
      break;
    }
    default:
      throw new HttpError(400, "Unknown action");
  }
  // Anything above may have made a held owner eligible (or not): look again now.
  await wakeOwner(ownerId);
  return Response.json({ ok: true });
});

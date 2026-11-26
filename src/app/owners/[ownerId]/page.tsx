import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { AutoRefresh } from "@/components/auto-refresh";
import { OwnerView } from "@/components/owners/owner-view";
import { PageHeader } from "@/components/page-header";
import { ownerEnrollments } from "@/lib/automation/engine";
import { now } from "@/lib/clock";
import { breakMissedCommitments, ownerCommitments } from "@/lib/commitments";
import { isUsableEmail } from "@/lib/import/plan";
import type { MessageRow } from "@/lib/messaging";
import { balancesByClient, getOwner, jointOwners, ownerReceivables } from "@/lib/owners";
import { rows } from "@/lib/sql";
import { listTemplates } from "@/lib/templates";
import { irishDate } from "@/lib/time";

export default async function Page({ params }: { params: Promise<{ ownerId: string }> }) {
  await connection();
  const { ownerId } = await params;
  const owner = await getOwner(ownerId);
  if (!owner) notFound();

  await breakMissedCommitments();
  const t = await now();
  const [receivables, joint, commitments, enrollments, templates] = await Promise.all([
    ownerReceivables(ownerId),
    jointOwners(ownerId),
    ownerCommitments(ownerId),
    ownerEnrollments(ownerId),
    listTemplates(),
  ]);
  const units = await rows<{ unit_ref: string; development: string; client: string; active: boolean; sold_note: string | null; archived: boolean }>(
    `select u.unit_ref, d.name as development, c.name as client, uo.active, uo.sold_note, u.archived_at is not null as archived
       from unit_owners uo join units u on u.id = uo.unit_id join developments d on d.id = u.development_id
       join clients c on c.id = d.client_id where uo.owner_id = $1 order by uo.active desc, u.unit_ref`,
    [ownerId],
  );
  const threads = await rows<{ id: string; subject: string; created_at: string }>(
    "select id, subject, created_at from threads where owner_id = $1 order by created_at",
    [ownerId],
  );
  const messages = await rows<MessageRow>("select * from messages where owner_id = $1 order by created_at", [ownerId]);
  const events = await rows<{ id: string; kind: string; summary: string; created_at: string }>(
    "select id, kind, summary, created_at from events where owner_id = $1 order by created_at desc, id desc limit 300",
    [ownerId],
  );

  return (
    <>
      <PageHeader
        title={owner.full_name}
        description="Owner"
        actions={
          <Link href="/owners" className="text-sm text-muted-foreground hover:text-foreground">
            ← All owners
          </Link>
        }
      />
      <AutoRefresh seconds={10} />
      <main className="mx-auto w-full max-w-7xl p-6 md:p-10">
        <OwnerView
          owner={owner}
          emailUsable={isUsableEmail(owner.email)}
          today={irishDate(t)}
          receivables={receivables}
          balances={balancesByClient(receivables)}
          joint={joint.map((j) => ({
            id: j.id,
            name: j.full_name,
            units: j.unit_refs,
            canEmail: !j.do_not_contact && isUsableEmail(j.email),
          }))}
          units={units}
          commitments={commitments}
          enrollments={enrollments}
          threads={threads.map((th) => ({ ...th, messages: messages.filter((m) => m.thread_id === th.id) }))}
          events={events}
          templates={templates.map((tpl) => ({ id: tpl.id, subject: tpl.subject }))}
          localMode={!process.env.RESEND_API_KEY}
        />
      </main>
    </>
  );
}

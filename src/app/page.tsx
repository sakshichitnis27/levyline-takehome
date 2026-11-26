import Link from "next/link";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { now } from "@/lib/clock";
import { breakMissedCommitments } from "@/lib/commitments";
import { rows, toCents } from "@/lib/sql";
import { formatDateTime, formatEuro, inContactHours } from "@/lib/time";

// What needs attention today.
export default async function Home() {
  await connection();
  await breakMissedCommitments();
  const t = await now();
  const [totals] = await rows<{ charged: string | null; paid: string | null; outstanding: string | null; owners: number }>(
    `select sum(r.amount) filter (where r.amount > 0) as charged, sum(least(r.paid, greatest(r.amount, 0))) as paid,
            sum(greatest(r.amount - r.paid, 0)) as outstanding,
            (select count(*)::int from owners) as owners
       from receivables r join units u on u.id = r.unit_id and u.archived_at is null`,
  );
  const replies = await rows<{ owner_id: string; full_name: string; subject: string; body: string; created_at: string; paused: boolean }>(
    `select m.owner_id, o.full_name, m.subject, m.body, m.created_at, o.automation_paused as paused
       from messages m join owners o on o.id = m.owner_id
      where m.direction = 'in' order by m.created_at desc limit 8`,
  );
  const [unmatched] = await rows<{ n: number }>("select count(*)::int as n from messages where direction = 'in' and owner_id is null");
  const broken = await rows<{ owner_id: string; full_name: string; client: string; broken_at: string }>(
    `select c.owner_id, o.full_name, cl.name as client, c.broken_at from commitments c join owners o on o.id = c.owner_id
       join clients cl on cl.id = c.client_id where c.status = 'broken' order by c.broken_at desc`,
  );
  const held = await rows<{ owner_id: string; full_name: string; automation: string; state: string; reason: string | null }>(
    `select e.owner_id, o.full_name, a.name as automation, e.state, coalesce(e.hold_reason, e.last_error) as reason
       from enrollments e join owners o on o.id = e.owner_id join automations a on a.id = e.automation_id
      where e.state in ('held', 'failed') order by e.state, o.full_name`,
  );
  const failed = await rows<{ owner_id: string; full_name: string; subject: string; last_error: string }>(
    `select m.owner_id, o.full_name, m.subject, m.last_error from messages m join owners o on o.id = m.owner_id
      where m.direction = 'out' and m.status = 'failed' and m.source <> 'automation' order by m.created_at desc limit 10`,
  );
  const charged = toCents(totals?.charged ?? 0);
  const paid = toCents(totals?.paid ?? 0);
  const pct = charged ? Math.round((paid / charged) * 100) : 0;

  return (
    <>
      <PageHeader title="Today" description={`${formatDateTime(t)} Irish time · ${inContactHours(t) ? "inside" : "outside"} contact hours`} />
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
        {totals?.owners === 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Start with an import</CardTitle>
              <CardDescription>
                <Link href="/import" className="underline">Import</Link> the managing agent's export to see owners and balances here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Card size="sm">
            <CardHeader>
              <CardDescription>Outstanding</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{formatEuro(toCents(totals?.outstanding ?? 0))}</CardTitle>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>Collected of charged</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {formatEuro(paid)} <span className="text-base font-normal text-muted-foreground">of {formatEuro(charged)}</span>
              </CardTitle>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>Unmatched replies</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                <Link href="/inbox" className="hover:underline">{unmatched?.n ?? 0}</Link>
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Latest replies" empty="No replies yet.">
            {replies.map((r, i) => (
              <Row key={i} href={`/owners/${r.owner_id}`} name={r.full_name} meta={formatDateTime(r.created_at)}>
                <span className="line-clamp-1">{r.body}</span>
                {r.paused && <Badge variant="outline">automation paused</Badge>}
              </Row>
            ))}
          </Section>
          <Section title="Broken commitments" empty="None.">
            {broken.map((b, i) => (
              <Row key={i} href={`/owners/${b.owner_id}`} name={b.full_name} meta={b.client}>
                Broken {formatDateTime(b.broken_at)}
              </Row>
            ))}
          </Section>
          <Section title="Held back from automations, and why" empty="Nobody is held back.">
            {held.map((h, i) => (
              <Row key={i} href={`/owners/${h.owner_id}`} name={h.full_name} meta={h.automation}>
                {h.state === "failed" && <Badge variant="destructive">failed</Badge>} {h.reason}
              </Row>
            ))}
          </Section>
          <Section title="Emails that failed to send" empty="None.">
            {failed.map((f, i) => (
              <Row key={i} href={`/owners/${f.owner_id}`} name={f.full_name} meta={f.subject}>
                {f.last_error}
              </Row>
            ))}
          </Section>
        </div>
      </main>
    </>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{children.length ? children : <p className="text-sm text-muted-foreground">{empty}</p>}</CardContent>
    </Card>
  );
}

function Row({ href, name, meta, children }: { href: string; name: string; meta: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block rounded-lg px-2 py-1.5 hover:bg-muted">
      <div className="flex justify-between gap-2 text-sm">
        <span className="font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{meta}</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">{children}</div>
    </Link>
  );
}

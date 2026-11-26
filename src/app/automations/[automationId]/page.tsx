import { notFound } from "next/navigation";
import { connection } from "next/server";

import { AutoRefresh } from "@/components/auto-refresh";
import { AutomationCanvas } from "@/components/automation-canvas";
import { PageHeader } from "@/components/page-header";
import { getAutomation } from "@/lib/automation/store";
import { rows } from "@/lib/sql";
import { listTemplates } from "@/lib/templates";

export default async function Page({ params }: { params: Promise<{ automationId: string }> }) {
  await connection();
  const { automationId } = await params;
  const a = await getAutomation(automationId);
  if (!a) notFound();
  const [clients, templates] = await Promise.all([
    rows<{ id: string; name: string }>("select id, name from clients order by name"),
    listTemplates(),
  ]);
  const owners = a.client_id
    ? await rows<{ id: string; name: string }>(
        `select distinct o.id, o.full_name as name from owners o join unit_owners uo on uo.owner_id = o.id and uo.active
           join receivables r on r.unit_id = uo.unit_id where r.client_id = $1 order by name`,
        [a.client_id],
      )
    : [];
  return (
    <>
      <PageHeader title={a.name} description="Automation" />
      <AutoRefresh seconds={15} />
      <main className="relative h-[calc(100svh-3.5rem)]">
        <AutomationCanvas
          key={a.updated_at}
          id={a.id}
          name={a.name}
          clientId={a.client_id}
          status={a.status}
          graph={a.graph}
          liveGraph={a.live_graph}
          counts={a.counts ?? {}}
          clients={clients}
          templates={templates.map((t) => ({ id: t.id, subject: t.subject, body: t.body }))}
          owners={owners}
        />
      </main>
    </>
  );
}

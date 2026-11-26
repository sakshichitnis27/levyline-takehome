import Link from "next/link";
import { connection } from "next/server";
import { WorkflowIcon } from "lucide-react";

import { NewAutomationButton } from "@/components/automations/new-automation-button";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { stepLabel } from "@/lib/automation/graph";
import { listAutomations } from "@/lib/automation/store";
import { formatDateTime } from "@/lib/time";

export default async function Page() {
  await connection();
  const automations = await listAutomations();
  return (
    <>
      <PageHeader title="Automations" description="Reminder emails that run on their own" actions={<NewAutomationButton />} />
      <main className="mx-auto w-full max-w-5xl p-6 md:p-10">
        {automations.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No automations yet</EmptyTitle>
              <EmptyDescription>Design how owners are chased on a canvas, then turn it on for the owners you choose.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <NewAutomationButton />
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {automations.map((a) => (
              <Link key={a.id} href={`/automations/${a.id}`}>
                <Card className="h-full transition-colors hover:bg-muted/50">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2">
                      {a.name}
                      <Badge variant={a.status === "live" ? "default" : a.status === "paused" ? "outline" : "secondary"}>
                        {a.status === "live" ? "On" : a.status === "paused" ? "Paused" : "Draft"}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      {a.client_name ?? "No client chosen"} · {a.graph.nodes.filter((n) => n.type !== "start" && n.type !== "end").map((n) => stepLabel(n)).join(" → ") || "empty"}
                    </CardDescription>
                    <CardDescription>
                      {Object.entries(a.counts ?? {}).map(([s, n]) => `${n} ${s}`).join(" · ") || "No owners yet"} · edited {formatDateTime(a.updated_at)}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

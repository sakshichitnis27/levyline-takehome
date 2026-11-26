import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { ClockForm } from "@/components/settings/clock-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getClockSettings, now } from "@/lib/clock";
import { formatDateTime, inContactHours } from "@/lib/time";

export default async function Page() {
  await connection();
  const settings = await getClockSettings();
  const t = await now();
  const dayMinutes = settings.speed !== 1 ? Math.round((1440 / settings.speed) * 100) / 100 : null;
  return (
    <>
      <PageHeader title="Settings" description="Development clock and email mode" />
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6 md:p-10">
        <Card>
          <CardHeader>
            <CardTitle>App clock</CardTitle>
            <CardDescription>
              Contact hours, one email a day, Waits, instalment dates and missed payments all use this clock, so you can test them without waiting days.
              The same can be set with LEVYLINE_NOW, LEVYLINE_DAY_MINUTES and LEVYLINE_FREEZE in .env.local.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-lg font-semibold">{formatDateTime(t)}</span>
              <span className="text-muted-foreground">Irish time</span>
              <Badge variant={inContactHours(t) ? "default" : "outline"}>{inContactHours(t) ? "Inside contact hours" : "Outside contact hours"}</Badge>
              <Badge variant="secondary">
                {settings.source === "real" ? "Real time" : settings.source === "env" ? "Set from .env.local" : "Set here"}
              </Badge>
              {settings.frozen && <Badge variant="outline">Frozen</Badge>}
              {dayMinutes && <Badge variant="outline">1 day = {dayMinutes} min</Badge>}
            </div>
            <ClockForm dayMinutes={dayMinutes} frozen={settings.frozen} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Email</CardTitle>
            <CardDescription>
              {process.env.RESEND_API_KEY
                ? `Sending through Resend. Every email is redirected to ${process.env.EMAIL_REDIRECT_TO}; replies come back via ${process.env.EMAIL_RECEIVING_DOMAIN || "(set EMAIL_RECEIVING_DOMAIN)"}.`
                : "Local mode: emails are written to .mailbox/outbox and about 1 in 10 sends fail on purpose (EMAIL_LOCAL_FAILURE_RATE). Use “Simulate a reply” on an owner's conversation, or npm run email:simulate-reply."}
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    </>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  BanIcon,
  CircleAlertIcon,
  HandshakeIcon,
  MailIcon,
  MapPinIcon,
  PauseIcon,
  PencilIcon,
  PhoneIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Conversation, type Thread } from "@/components/owners/conversation";
import { CommitmentDialog } from "@/components/owners/commitment-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { EnrollmentView } from "@/lib/automation/engine";
import { api } from "@/lib/client";
import type { CommitmentView } from "@/lib/commitments";
import type { OwnerReceivable, OwnerRow } from "@/lib/owners";
import { daysBetween, formatDate, formatDateTime, formatEuro } from "@/lib/time";

export type OwnerViewProps = {
  owner: OwnerRow;
  emailUsable: boolean;
  today: string;
  receivables: OwnerReceivable[];
  balances: { clientId: string; clientName: string; balanceCents: number }[];
  joint: { id: string; name: string; units: string[]; canEmail: boolean }[];
  units: { unit_ref: string; development: string; client: string; active: boolean; sold_note: string | null; archived: boolean }[];
  commitments: CommitmentView[];
  enrollments: EnrollmentView[];
  threads: Thread[];
  events: { id: string; kind: string; summary: string; created_at: string }[];
  templates: { id: string; subject: string }[];
  localMode: boolean;
};

export function useAction(ownerId: string) {
  const router = useRouter();
  return async (body: Record<string, unknown>, success?: string) => {
    try {
      await api(`/api/owners/${ownerId}/actions`, { body });
      if (success) toast.success(success);
      router.refresh();
      return true;
    } catch (error) {
      toast.error((error as Error).message);
      return false;
    }
  };
}

export function OwnerView(props: OwnerViewProps) {
  const { owner, receivables, commitments, enrollments, today } = props;
  const act = useAction(owner.id);

  const disputed = receivables.filter((r) => r.disputed);
  const active = commitments.filter((c) => c.status === "active");
  const broken = commitments.filter((c) => c.status === "broken");
  const running = enrollments.filter((e) => ["active", "waiting", "held", "failed"].includes(e.state));
  const held = running.filter((e) => e.state === "held" || e.state === "failed");
  const sold = props.units.filter((u) => u.active && u.sold_note);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">{owner.full_name}</h2>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <MailIcon className="size-4" />
              {owner.email ?? "No email"}
              {!props.emailUsable && (
                <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">
                  {owner.email ? "Not a usable address" : "Automations can't reach them"}
                </Badge>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <PhoneIcon className="size-4" />
              {owner.phone ?? "No phone"}
            </span>
            {owner.address && (
              <span className="flex items-center gap-1.5">
                <MapPinIcon className="size-4" />
                {owner.address}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {owner.do_not_contact && <Badge variant="destructive">Do not contact</Badge>}
            {owner.deceased && <Badge variant="destructive">Deceased</Badge>}
            {broken.length > 0 && <Badge variant="destructive">Commitment broken</Badge>}
            {disputed.length > 0 && (
              <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">
                {disputed.length} disputed
              </Badge>
            )}
            {active.length > 0 && <Badge>Commitment active</Badge>}
            {running.length > 0 && <Badge variant="secondary">In {running.length === 1 ? "an automation" : `${running.length} automations`}</Badge>}
            {owner.automation_paused && (
              <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">
                Automation paused
              </Badge>
            )}
            {sold.length > 0 && <Badge variant="outline">Sold {sold.map((s) => s.unit_ref).join(", ")}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CommitmentDialog ownerId={owner.id} receivables={receivables} today={today} hasEmail={props.emailUsable && !owner.do_not_contact} />
          <DncDialog owner={owner} onSave={act} />
          {owner.automation_paused ? (
            <Button variant="outline" onClick={() => act({ action: "automation", paused: false }, "Automated emails resumed")}>
              <PlayIcon /> Resume automation
            </Button>
          ) : (
            <Button variant="outline" onClick={() => act({ action: "automation", paused: true }, "Automated emails paused")}>
              <PauseIcon /> Pause automation
            </Button>
          )}
          <ContactDialog owner={owner} onSave={act} />
        </div>
      </div>

      {/* Things staff must know first */}
      <div className="space-y-2">
        {owner.do_not_contact && (
          <Notice tone="red" title="Do not contact" icon={<BanIcon />}>
            No email of any kind, by hand or automation. You can still record a commitment.
            {owner.do_not_contact_reason && <> Reason: “{owner.do_not_contact_reason}”.</>}
          </Notice>
        )}
        {owner.deceased && (
          <Notice tone="red" title="Owner recorded as deceased" icon={<CircleAlertIcon />}>
            {owner.deceased_note ? `“${owner.deceased_note}”. ` : ""}Automations won't email them; write to the estate by hand if appropriate.
          </Notice>
        )}
        {broken.map((c) => (
          <Notice key={c.id} tone="red" title={`Commitment with ${c.clientName} broken`} icon={<HandshakeIcon />}>
            A payment was missed. Its receivables ({c.receivables.join(", ")}) can be chased again.
          </Notice>
        ))}
        {owner.automation_paused && (
          <Notice tone="amber" title="Automated emails paused" icon={<PauseIcon />}>
            {owner.automation_paused_reason ?? "Paused by staff"}. Resume when you're ready for automations to carry on.
          </Notice>
        )}
        {held.map((e) => (
          <Notice
            key={e.id}
            tone="amber"
            title={`${e.automationName}: ${e.state === "failed" ? "an email failed" : "held back"} at “${e.currentStep}”`}
            icon={<CircleAlertIcon />}
          >
            {e.state === "failed" ? e.lastError : e.holdReason}
            {e.state === "failed" && (
              <Button size="xs" variant="outline" className="ml-2" onClick={() => act({ action: "retry-enrollment", enrollmentId: e.id }, "Retrying")}>
                <RotateCcwIcon /> Retry
              </Button>
            )}
          </Notice>
        ))}
        {sold.map((u) => (
          <Notice key={u.unit_ref} tone="amber" title={`${u.unit_ref}: “${u.sold_note}”`} icon={<CircleAlertIcon />}>
            Automations won't chase this owner for {u.unit_ref}.
          </Notice>
        ))}
      </div>

      {/* Balance per client: money owed to one client can't pay another's */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {props.balances.length === 0 && <p className="text-sm text-muted-foreground">No current units.</p>}
        {props.balances.map((b) => (
          <Card key={b.clientId} size="sm">
            <CardHeader>
              <CardDescription>{b.clientName}</CardDescription>
              <CardTitle className={`text-2xl tabular-nums ${b.balanceCents <= 0 ? "text-muted-foreground" : ""}`}>
                {formatEuro(b.balanceCents)}
              </CardTitle>
              <CardDescription>{b.balanceCents < 0 ? "In credit" : b.balanceCents === 0 ? "Nothing owed" : "Outstanding"}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Receivables</TabsTrigger>
          <TabsTrigger value="conversation">
            Conversation {props.threads.length > 0 && <Badge variant="secondary">{props.threads.reduce((s, t) => s + t.messages.length, 0)}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="commitments">Commitments</TabsTrigger>
          <TabsTrigger value="automations">Automations</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Receivables {...props} onAct={act} />
          <UnitsCard units={props.units} joint={props.joint} />
        </TabsContent>

        <TabsContent value="conversation">
          <Conversation
            ownerId={owner.id}
            threads={props.threads}
            templates={props.templates}
            clients={props.balances}
            joint={props.joint}
            blocked={owner.do_not_contact ? "This owner is do not contact: no email of any kind." : !props.emailUsable ? "This owner has no usable email address. Add one with Edit contact." : null}
            localMode={props.localMode}
          />
        </TabsContent>

        <TabsContent value="commitments">
          <Commitments commitments={commitments} onAct={act} />
        </TabsContent>

        <TabsContent value="automations">
          <Automations enrollments={enrollments} onAct={act} />
        </TabsContent>

        <TabsContent value="timeline">
          <Card>
            <CardContent>
              <ol className="relative space-y-4 border-l pl-6">
                {props.events.map((e) => (
                  <li key={e.id}>
                    <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-background bg-muted-foreground/40" />
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(e.created_at)} · {e.kind}
                    </div>
                    <div className="text-sm">{e.summary}</div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Notice({ tone, title, icon, children }: { tone: "red" | "amber"; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Alert
      variant={tone === "red" ? "destructive" : "default"}
      className={tone === "amber" ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" : undefined}
    >
      {icon}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className={tone === "amber" ? "text-amber-900/80 dark:text-amber-200/80" : undefined}>{children}</AlertDescription>
    </Alert>
  );
}

function overdueLabel(r: OwnerReceivable, today: string) {
  if (r.outstandingCents <= 0) return <span className="text-muted-foreground">{r.outstandingCents < 0 ? "Credit" : "Paid"}</span>;
  const days = daysBetween(r.dueDate, today);
  if (days < 0) return <span className="text-muted-foreground">Due in {-days} day{days === -1 ? "" : "s"}</span>;
  if (days === 0) return <span>Due today</span>;
  return <span className={days > 30 ? "font-medium text-destructive" : "text-amber-700 dark:text-amber-400"}>{days} days overdue</span>;
}

function Receivables({ receivables, today, onAct }: OwnerViewProps & { onAct: ReturnType<typeof useAction> }) {
  const groups = new Map<string, OwnerReceivable[]>();
  for (const r of receivables) {
    const key = `${r.clientName} · ${r.developmentName} · ${r.unitRef}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (!receivables.length) return <p className="text-sm text-muted-foreground">No receivables on current units.</p>;
  return (
    <div className="space-y-4">
      {[...groups].map(([key, list]) => (
        <Card key={key}>
          <CardHeader>
            <CardTitle className="text-sm">{key}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Demand</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead>Overdue</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.demandRef}</TableCell>
                    <TableCell className="whitespace-normal">
                      {r.kind}
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {r.disputed && (
                          <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400" title={r.disputeReason ?? ""}>
                            Disputed
                          </Badge>
                        )}
                        {r.inActiveCommitment && <Badge>In commitment</Badge>}
                      </div>
                      {r.disputed && r.disputeReason && <div className="text-xs text-muted-foreground">{r.disputeReason}</div>}
                      {r.notes && r.notes !== r.disputeReason && <div className="text-xs text-muted-foreground">Note: {r.notes}</div>}
                    </TableCell>
                    <TableCell>{r.period}</TableCell>
                    <TableCell className="tabular-nums">{formatDate(r.dueDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatEuro(r.amountCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatEuro(r.paidCents)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatEuro(r.outstandingCents)}</TableCell>
                    <TableCell className="text-sm">{overdueLabel(r, today)}</TableCell>
                    <TableCell className="text-right">
                      {r.disputed ? (
                        <Button size="xs" variant="ghost" onClick={() => onAct({ action: "dispute", receivableId: r.id, on: false }, `${r.demandRef} dispute resolved`)}>
                          Resolve dispute
                        </Button>
                      ) : (
                        <DisputeDialog demandRef={r.demandRef} onSave={(reason) => onAct({ action: "dispute", receivableId: r.id, on: true, reason }, `${r.demandRef} marked disputed`)} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UnitsCard({ units, joint }: { units: OwnerViewProps["units"]; joint: OwnerViewProps["joint"] }) {
  const past = units.filter((u) => !u.active || u.archived);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Units and joint owners</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {joint.length > 0 && (
          <div>
            Joint owners:{" "}
            {joint.map((j, i) => (
              <span key={j.id}>
                {i > 0 && ", "}
                <Link className="underline underline-offset-2" href={`/owners/${j.id}`}>
                  {j.name}
                </Link>{" "}
                <span className="text-muted-foreground">({j.units.join(", ")})</span>
              </span>
            ))}
            <span className="text-muted-foreground">. Each is liable for the whole of a shared unit.</span>
          </div>
        )}
        {past.length > 0 && (
          <div className="text-muted-foreground">
            Previously: {past.map((u) => `${u.unit_ref} (${u.archived ? "archived" : "no longer an owner"})`).join(", ")}
          </div>
        )}
        {joint.length === 0 && past.length === 0 && <div className="text-muted-foreground">Sole owner of every unit above.</div>}
      </CardContent>
    </Card>
  );
}

function Commitments({ commitments, onAct }: { commitments: CommitmentView[]; onAct: ReturnType<typeof useAction> }) {
  if (!commitments.length) return <p className="text-sm text-muted-foreground">No commitments yet. Use “Record commitment” above.</p>;
  return (
    <div className="space-y-4">
      {commitments.map((c) => (
        <Card key={c.id}>
          <CardHeader className="flex flex-row items-start justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm">
                {c.clientName}
                <Badge variant={c.status === "broken" ? "destructive" : c.status === "active" ? "default" : "secondary"}>{c.status}</Badge>
              </CardTitle>
              <CardDescription>
                Recorded {formatDateTime(c.createdAt)} · covers {c.receivables.join(", ")}
                {c.note && ` · “${c.note}”`}
              </CardDescription>
            </div>
            {(c.status === "active" || c.status === "broken") && (
              <Button size="xs" variant="ghost" onClick={() => onAct({ action: "cancel-commitment", commitmentId: c.id }, "Commitment cancelled")}>
                Cancel
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.instalments.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.seq}</TableCell>
                    <TableCell>{formatDate(i.dueDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatEuro(i.amountCents)}</TableCell>
                    <TableCell>
                      {i.paidAt ? <Badge variant="secondary">Paid</Badge> : i.missed ? <Badge variant="destructive">Missed</Badge> : <span className="text-sm text-muted-foreground">Due</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.status !== "cancelled" && (
                        <Button size="xs" variant="outline" onClick={() => onAct({ action: "instalment", instalmentId: i.id, paid: !i.paidAt })}>
                          {i.paidAt ? "Mark unpaid" : "Mark paid"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  active: "Running",
  waiting: "Waiting",
  held: "Held back",
  failed: "Failed",
  completed: "Finished",
  stopped: "Removed",
};

function Automations({ enrollments, onAct }: { enrollments: EnrollmentView[]; onAct: ReturnType<typeof useAction> }) {
  if (!enrollments.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Not in any automation. Add owners from an automation on the <Link href="/automations" className="underline">Automations</Link> page.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {enrollments.map((e) => (
        <Card key={e.id}>
          <CardHeader className="flex flex-row items-start justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Link href={`/automations/${e.automationId}`} className="hover:underline">
                  {e.automationName}
                </Link>
                <Badge variant={e.state === "failed" ? "destructive" : e.state === "held" ? "outline" : "secondary"}>{STATE_LABEL[e.state]}</Badge>
              </CardTitle>
              <CardDescription>
                {["completed", "stopped"].includes(e.state) ? "Last step" : "Now at"}: {e.currentStep}
                {e.state === "waiting" && ` until ${formatDateTime(e.wakeAt)}`}
                {e.state === "held" && e.holdReason && ` · ${e.holdReason}`}
                {e.state === "failed" && e.lastError && ` · ${e.lastError}`}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {e.state === "failed" && (
                <Button size="xs" variant="outline" onClick={() => onAct({ action: "retry-enrollment", enrollmentId: e.id }, "Retrying")}>
                  <RotateCcwIcon /> Retry
                </Button>
              )}
              {!["completed", "stopped"].includes(e.state) && (
                <Button size="xs" variant="ghost" onClick={() => onAct({ action: "stop-enrollment", enrollmentId: e.id }, "Removed from automation")}>
                  Remove
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {e.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No steps yet.</p>
            ) : (
              <ol className="space-y-1 text-sm">
                {e.steps.map((s) => (
                  <li key={s.nodeId} className="flex flex-wrap gap-2">
                    <span className="text-muted-foreground tabular-nums">{formatDateTime(s.at)}</span>
                    <span>{s.label}</span>
                    {s.messageStatus && <Badge variant={s.messageStatus === "sent" ? "secondary" : "destructive"}>{s.messageStatus}</Badge>}
                    {s.detail && <span className="text-muted-foreground">{s.detail}</span>}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function DncDialog({ owner, onSave }: { owner: OwnerRow; onSave: ReturnType<typeof useAction> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (owner.do_not_contact) {
    return (
      <Button variant="outline" onClick={() => onSave({ action: "dnc", on: false }, "Do not contact cleared")}>
        <BanIcon /> Clear do not contact
      </Button>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <BanIcon /> Do not contact
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {owner.full_name} do not contact?</DialogTitle>
          <DialogDescription>No email of any kind: not by hand, not from automations. You can still record commitments.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="dnc-reason">Reason</Label>
          <Input id="dnc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. solicitor acting" />
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={async () => {
              if (await onSave({ action: "dnc", on: true, reason }, "Marked do not contact")) setOpen(false);
            }}
          >
            Mark do not contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContactDialog({ owner, onSave }: { owner: OwnerRow; onSave: ReturnType<typeof useAction> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(owner.email ?? "");
  const [phone, setPhone] = useState(owner.phone ?? "");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost">
          <PencilIcon /> Edit contact
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Contact details</DialogTitle>
          <DialogDescription>Your change survives a re-import, unless the file itself changes the same field.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="c-email">Email</Label>
            <Input id="c-email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-phone">Phone</Label>
            <Input id="c-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              if (await onSave({ action: "contact", email, phone }, "Contact details saved")) setOpen(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisputeDialog({ demandRef, onSave }: { demandRef: string; onSave: (reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="xs" variant="ghost">
          Mark disputed
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispute {demandRef}</DialogTitle>
          <DialogDescription>Automations won't chase a disputed receivable until you resolve it.</DialogDescription>
        </DialogHeader>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What's the owner disputing?" />
        <DialogFooter>
          <Button
            onClick={async () => {
              if (await onSave(reason)) setOpen(false);
            }}
          >
            Mark disputed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

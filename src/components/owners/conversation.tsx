"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BotIcon, HandshakeIcon, Loader2Icon, MessageSquareReplyIcon, PlusIcon, RotateCcwIcon, SendIcon, UserIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import type { MessageRow } from "@/lib/messaging";
import { formatDateTime } from "@/lib/time";

export type Thread = { id: string; subject: string; created_at: string; messages: MessageRow[] };

const SOURCE: Record<string, { label: string; icon: typeof UserIcon }> = {
  staff: { label: "Staff", icon: UserIcon },
  automation: { label: "Automation", icon: BotIcon },
  commitment: { label: "Commitment confirmation", icon: HandshakeIcon },
  owner: { label: "Owner", icon: MessageSquareReplyIcon },
};

export function Conversation({
  ownerId,
  threads,
  templates,
  clients,
  joint,
  blocked,
  localMode,
}: {
  ownerId: string;
  threads: Thread[];
  templates: { id: string; subject: string }[];
  clients: { clientId: string; clientName: string }[];
  joint: { id: string; name: string; units: string[]; canEmail: boolean }[];
  blocked: string | null;
  localMode: boolean;
}) {
  const latest = [...threads].sort(
    (a, b) =>
      new Date(b.messages.at(-1)?.created_at ?? b.created_at).getTime() - new Date(a.messages.at(-1)?.created_at ?? a.created_at).getTime(),
  )[0];
  const [threadId, setThreadId] = useState<string | "new">(latest?.id ?? "new");
  const thread = threads.find((t) => t.id === threadId);

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card size="sm" className="h-fit">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Conversations</CardTitle>
          <Button size="xs" variant="outline" onClick={() => setThreadId("new")} disabled={Boolean(blocked)}>
            <PlusIcon /> New
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {threads.length === 0 && <p className="text-sm text-muted-foreground">No emails yet.</p>}
          {threads.map((t) => {
            const last = t.messages.at(-1);
            const replies = t.messages.filter((m) => m.direction === "in").length;
            return (
              <button
                key={t.id}
                onClick={() => setThreadId(t.id)}
                className={`w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted ${t.id === threadId ? "bg-muted" : ""}`}
              >
                <div className="truncate font-medium">{t.subject}</div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {last && formatDateTime(last.created_at)}
                  {replies > 0 && <Badge variant="secondary">{replies} repl{replies === 1 ? "y" : "ies"}</Badge>}
                  {t.messages.some((m) => m.status === "failed") && <Badge variant="destructive">failed</Badge>}
                </div>
              </button>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{thread ? thread.subject : "New email"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {thread && (
            <div className="space-y-3">
              {thread.messages.map((m) => (
                <Bubble key={m.id} message={m} localMode={localMode} />
              ))}
            </div>
          )}
          {blocked ? (
            <Alert variant="destructive">
              <AlertDescription>{blocked}</AlertDescription>
            </Alert>
          ) : (
            <Composer
              key={threadId}
              ownerId={ownerId}
              thread={thread ?? null}
              templates={templates}
              clients={clients}
              joint={joint}
              onSent={(id) => id && setThreadId(id)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Bubble({ message: m, localMode }: { message: MessageRow; localMode: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const incoming = m.direction === "in";
  const source = SOURCE[m.source] ?? SOURCE.staff;

  async function retry() {
    setBusy(true);
    try {
      const res = await api<{ status: string; error: string | null }>(`/api/messages/${m.id}/retry`, { body: {} });
      if (res.status === "sent") toast.success("Sent");
      else toast.error(`Still failing: ${res.error}`);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function simulate(deliveries: number) {
    setBusy(true);
    try {
      await api(`/api/messages/${m.id}/simulate-reply`, { body: { text: replyText, deliveries } });
      toast.success(deliveries > 1 ? "Reply webhook sent twice" : "Reply simulated");
      setReplyText(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex ${incoming ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] space-y-1 ${incoming ? "" : "items-end text-right"}`}>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <source.icon className="size-3" />
          {incoming ? `Reply from ${m.from_address ?? "owner"}` : `${source.label} to ${m.to_address ?? "owner"}`} · {formatDateTime(m.sent_at ?? m.created_at)}
        </div>
        <div
          className={`rounded-2xl px-3 py-2 text-left text-sm whitespace-pre-wrap ${
            incoming ? "bg-muted" : m.status === "failed" ? "border border-destructive/40 bg-destructive/5" : "bg-primary text-primary-foreground"
          }`}
        >
          {!incoming && <div className="mb-1 text-xs font-medium opacity-80">{m.subject}</div>}
          {m.body}
        </div>
        {!incoming && (
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            {m.status === "sent" && <span className="text-muted-foreground">Sent</span>}
            {(m.status === "queued" || m.status === "sending") && <span className="text-muted-foreground">Sending…</span>}
            {m.status === "failed" && (
              <>
                <span className="text-destructive">
                  Not sent: {m.last_error} ({m.attempts} attempt{m.attempts === 1 ? "" : "s"})
                </span>
                {m.source !== "automation" && (
                  <Button size="xs" variant="outline" onClick={retry} disabled={busy}>
                    <RotateCcwIcon /> Retry
                  </Button>
                )}
              </>
            )}
            {localMode && m.status === "sent" && replyText === null && (
              <Button size="xs" variant="ghost" onClick={() => setReplyText("")}>
                Simulate a reply
              </Button>
            )}
          </div>
        )}
        {replyText !== null && (
          <div className="flex gap-2">
            <Input autoFocus value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="The owner writes…" />
            <Button size="sm" onClick={() => simulate(1)} disabled={busy}>
              Reply
            </Button>
            <Button size="sm" variant="outline" onClick={() => simulate(2)} disabled={busy} title="Deliver the webhook twice, as real providers sometimes do">
              ×2
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  ownerId,
  thread,
  templates,
  clients,
  joint,
  onSent,
}: {
  ownerId: string;
  thread: Thread | null;
  templates: { id: string; subject: string }[];
  clients: { clientId: string; clientName: string }[];
  joint: { id: string; name: string; units: string[]; canEmail: boolean }[];
  onSent: (threadId: string | null) => void;
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(thread ? `Re: ${thread.subject}` : "");
  const [body, setBody] = useState("");
  const [template, setTemplate] = useState("");
  const [clientId, setClientId] = useState(clients[0]?.clientId ?? "");
  const [also, setAlso] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!template) return;
    api<{ subject: string; body: string; missing: string[] }>(`/api/owners/${ownerId}/render?template=${template}&clientId=${clientId}`)
      .then((r) => {
        if (!thread) setSubject(r.subject);
        setBody(r.body);
        if (r.missing.length) toast.warning(`Fill in: ${r.missing.map((m) => `{{${m}}}`).join(", ")}`);
      })
      .catch((e) => toast.error(e.message));
  }, [template, clientId, ownerId, thread]);

  async function send() {
    setBusy(true);
    try {
      const res = await api<{ results: { name: string; threadId: string; status: string; error: string | null }[] }>(`/api/owners/${ownerId}/messages`, {
        body: { threadId: thread?.id, subject, body, jointOwnerIds: also },
      });
      for (const r of res.results) {
        if (r.status === "sent") toast.success(`Sent to ${r.name}`);
        else toast.error(`Not sent to ${r.name}: ${r.error}. You can retry it from the conversation.`);
      }
      setBody("");
      setTemplate("");
      router.refresh();
      onSent(res.results[0]?.threadId ?? null);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const reachable = joint.filter((j) => j.canEmail);

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="flex flex-wrap gap-2">
        <NativeSelect value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Start from a template" size="sm">
          <NativeSelectOption value="">Start from a template…</NativeSelectOption>
          {templates.map((t) => (
            <NativeSelectOption key={t.id} value={t.id}>
              {t.id.replace(/-/g, " ")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {clients.length > 1 && (
          <NativeSelect value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="About which client" size="sm">
            {clients.map((c) => (
              <NativeSelectOption key={c.clientId} value={c.clientId}>
                About {c.clientName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" rows={6} aria-label="Message" />
      {reachable.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Also send to joint owners (each gets their own copy and conversation)</Label>
          {reachable.map((j) => (
            <label key={j.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={also.includes(j.id)}
                onCheckedChange={(c) => setAlso(c ? [...also, j.id] : also.filter((x) => x !== j.id))}
              />
              {j.name} ({j.units.join(", ")})
            </label>
          ))}
        </div>
      )}
      {joint.some((j) => !j.canEmail) && (
        <p className="text-xs text-muted-foreground">
          Can't email joint owner{joint.filter((j) => !j.canEmail).length > 1 ? "s" : ""} {joint.filter((j) => !j.canEmail).map((j) => j.name).join(", ")}: no usable email or do not contact.
        </p>
      )}
      <div className="flex justify-end">
        <Button onClick={send} disabled={busy || !subject.trim() || !body.trim()}>
          {busy ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Send
        </Button>
      </div>
    </div>
  );
}

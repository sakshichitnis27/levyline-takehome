"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { HandshakeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ApiError, api } from "@/lib/client";
import type { OwnerReceivable } from "@/lib/owners";
import { validateCommitment } from "@/lib/rules";
import { addDays, formatEuro } from "@/lib/time";

type Row = { dueDate: string; amount: string };

const toCents = (s: string) => Math.round(Number(s.replace(/[€,\s]/g, "")) * 100);

function splitEvenly(totalCents: number, count: number, first: string): Row[] {
  const base = Math.floor(totalCents / count);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    const cents = i === count - 1 ? totalCents - base * (count - 1) : base;
    return { dueDate: d.toISOString().slice(0, 10), amount: (cents / 100).toFixed(2) };
  });
}

export function CommitmentDialog({
  ownerId,
  receivables,
  today,
  hasEmail,
}: {
  ownerId: string;
  receivables: OwnerReceivable[];
  today: string;
  hasEmail: boolean;
}) {
  const router = useRouter();
  const clients = useMemo(
    () => [...new Map(receivables.map((r) => [r.clientId, r.clientName])).entries()].map(([id, name]) => ({ id, name })),
    [receivables],
  );
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([{ dueDate: addDays(today, 7), amount: "" }]);
  const [note, setNote] = useState("");
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const choosable = receivables.filter((r) => r.clientId === clientId && r.outstandingCents > 0);
  const chosenTotal = choosable.filter((r) => selected.includes(r.id)).reduce((s, r) => s + r.outstandingCents, 0);
  const planTotal = rows.reduce((s, r) => s + (toCents(r.amount) || 0), 0);

  // Same checks as the server (rules 11 to 13), shown as staff type.
  const errors = validateCommitment({
    draft: { clientId, receivableIds: selected, instalments: rows.map((r) => ({ dueDate: r.dueDate, amountCents: toCents(r.amount) })) },
    receivables,
    hasActiveCommitmentForClient: false,
    today,
  });

  function reset(cid: string) {
    setClientId(cid);
    const ids = receivables.filter((r) => r.clientId === cid && r.outstandingCents > 0 && !r.inActiveCommitment).map((r) => r.id);
    setSelected(ids);
    const total = receivables.filter((r) => ids.includes(r.id)).reduce((s, r) => s + r.outstandingCents, 0);
    setRows([{ dueDate: addDays(today, 7), amount: (total / 100).toFixed(2) }]);
    setServerErrors([]);
  }

  async function save() {
    setBusy(true);
    setServerErrors([]);
    try {
      const res = await api<{ confirmation: { status: string; reason?: string } }>(`/api/owners/${ownerId}/commitments`, {
        body: {
          clientId,
          receivableIds: selected,
          instalments: rows.map((r) => ({ dueDate: r.dueDate, amountCents: toCents(r.amount) })),
          note,
        },
      });
      toast.success(
        res.confirmation.status === "sent"
          ? "Commitment recorded and confirmation emailed"
          : res.confirmation.status === "skipped"
            ? `Commitment recorded. No confirmation email: ${res.confirmation.reason}`
            : `Commitment recorded, but the confirmation email failed: ${res.confirmation.reason}. Retry it from the conversation.`,
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setServerErrors(error instanceof ApiError && error.errors.length ? error.errors : [(error as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset(clientId || clients[0]?.id || "");
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={!clients.length}>
          <HandshakeIcon /> Record commitment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a commitment</DialogTitle>
          <DialogDescription>
            A promise to pay on one date, or a plan of up to 12 payments. While it's on track, automations won't chase what it covers.
            {hasEmail ? " The owner will be emailed a confirmation." : " No confirmation email will be sent (do not contact, or no usable email)."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {clients.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="cm-client">Client</Label>
              <NativeSelect id="cm-client" value={clientId} onChange={(e) => reset(e.target.value)}>
                {clients.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}

          <div className="space-y-1">
            <Label>Covers</Label>
            <div className="space-y-1 rounded-lg border p-2">
              {choosable.length === 0 && <p className="text-sm text-muted-foreground">Nothing outstanding for this client.</p>}
              {choosable.map((r) => (
                <label key={r.id} className={`flex items-center gap-2 text-sm ${r.inActiveCommitment ? "opacity-50" : ""}`}>
                  <Checkbox
                    disabled={r.inActiveCommitment}
                    checked={selected.includes(r.id)}
                    onCheckedChange={(c) => setSelected(c ? [...selected, r.id] : selected.filter((x) => x !== r.id))}
                  />
                  <span className="flex-1">
                    {r.demandRef} · {r.unitRef} · {r.kind}
                    {r.disputed && " · disputed"}
                    {r.inActiveCommitment && " · already in a commitment"}
                  </span>
                  <span className="tabular-nums">{formatEuro(r.outstandingCents)}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Payments</Label>
              <div className="flex flex-wrap gap-1">
                {[1, 3, 6, 12].map((n) => (
                  <Button key={n} size="xs" variant="outline" onClick={() => setRows(splitEvenly(chosenTotal, n, addDays(today, 7)))} disabled={!chosenTotal}>
                    {n === 1 ? "Pay in full" : `${n} monthly`}
                  </Button>
                ))}
              </div>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 text-sm text-muted-foreground tabular-nums">{i + 1}.</span>
                <Input
                  type="date"
                  className="w-44"
                  value={r.dueDate}
                  aria-label={`Payment ${i + 1} date`}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))}
                />
                <div className="relative">
                  <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                  <Input
                    className="w-36 pl-6 tabular-nums"
                    inputMode="decimal"
                    value={r.amount}
                    aria-label={`Payment ${i + 1} amount`}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                </div>
                {rows.length > 1 && (
                  <Button size="icon-sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove payment">
                    <Trash2Icon />
                  </Button>
                )}
              </div>
            ))}
            {rows.length < 12 && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setRows([...rows, { dueDate: addDays(rows.at(-1)?.dueDate || today, 30), amount: "" }])}
              >
                <PlusIcon /> Add a payment
              </Button>
            )}
            <p className="text-sm text-muted-foreground">
              Plan total {formatEuro(planTotal)} of {formatEuro(chosenTotal)} outstanding on the chosen receivables.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="cm-note">Note (optional)</Label>
            <Input id="cm-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed by phone" />
          </div>

          {(serverErrors.length > 0 || (errors.length > 0 && selected.length > 0)) && (
            <Alert variant="destructive">
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {(serverErrors.length ? serverErrors : errors).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button onClick={save} disabled={busy || errors.length > 0}>
            Record commitment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

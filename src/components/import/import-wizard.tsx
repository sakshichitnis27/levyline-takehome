"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileUpIcon,
  Loader2Icon,
  MailWarningIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/client";
import { parseCsv, toCsv, type DateOrder } from "@/lib/import/normalize";
import { FIELDS, suggestMapping, type Decisions, type ImportPlan, type Mapping } from "@/lib/import/plan";

type Step = "upload" | "map" | "preview" | "done";

const STATUS_LABEL = { create: "New", update: "Updated", unchanged: "No change" } as const;

export function ImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [mapping, setMapping] = useState<Mapping>({});
  const [decisions, setDecisions] = useState<Decisions>({ dateOrder: null, merges: {}, archiveUnitIds: [] });
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportPlan["counts"] | null>(null);

  const table = useMemo(() => (csv ? parseCsv(csv) : []), [csv]);
  const headers = table[0] ?? [];

  function load(name: string, text: string) {
    const rows = parseCsv(text);
    if (rows.length < 2) {
      toast.error("That file has no rows");
      return;
    }
    setFileName(name);
    setCsv(text);
    setMapping(suggestMapping(rows[0]));
    setDecisions({ dateOrder: null, merges: {}, archiveUnitIds: [] });
    setPlan(null);
    setResult(null);
    setStep("map");
    // Ask the server what it can tell about the date format straight away.
    void preview(text, suggestMapping(rows[0]), { dateOrder: null, merges: {}, archiveUnitIds: [] }, false);
  }

  async function preview(text = csv, m = mapping, d = decisions, go = true) {
    setBusy(true);
    try {
      const res = await api<{ plan: ImportPlan }>("/api/import/preview", { body: { csv: text, mapping: m, decisions: d } });
      setPlan(res.plan);
      if (!go && d.dateOrder === null && res.plan.dateFormat.detected) {
        setDecisions({ ...d, dateOrder: res.plan.dateFormat.detected });
      }
      if (go) setStep("preview");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(next: Decisions) {
    setDecisions(next);
    await preview(csv, mapping, next);
  }

  async function commit() {
    setBusy(true);
    try {
      const res = await api<{ counts: ImportPlan["counts"] }>("/api/import/commit", {
        body: { csv, fileName, mapping, decisions },
      });
      setResult(res.counts);
      setStep("done");
      toast.success("Import finished");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const missingRequired = FIELDS.filter((f) => f.required && mapping[f.id] === undefined);

  return (
    <div className="space-y-6">
      <Steps step={step} />

      {step === "upload" && <Upload onLoad={load} />}

      {step === "map" && (
        <Card>
          <CardHeader>
            <CardTitle>Match the columns</CardTitle>
            <CardDescription>
              {fileName}: {table.length - 1} rows. We've matched the columns we recognise; check them, then preview.
              Nothing is saved yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((field) => (
                <div key={field.id} className="space-y-1">
                  <Label htmlFor={`map-${field.id}`} className="text-xs">
                    {field.label}
                    {field.required && <span className="text-destructive">*</span>}
                  </Label>
                  <NativeSelect
                    id={`map-${field.id}`}
                    className="w-full"
                    value={mapping[field.id] ?? ""}
                    onChange={(e) =>
                      setMapping({ ...mapping, [field.id]: e.target.value === "" ? undefined : Number(e.target.value) })
                    }
                  >
                    <NativeSelectOption value="">Not in this file</NativeSelectOption>
                    {headers.map((h, i) => (
                      <NativeSelectOption key={i} value={i}>
                        {h}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ))}
            </div>

            <div className="rounded-lg border p-4">
              <Label htmlFor="date-order" className="font-medium">
                How are dates written in this file?
              </Label>
              <p className="mt-1 text-sm text-muted-foreground">
                {plan?.dateFormat.conflicting
                  ? `The file mixes both orders (${plan.dateFormat.evidence}). Dates that could be read either way will be skipped unless you choose.`
                  : plan?.dateFormat.detected
                    ? `“${plan.dateFormat.evidence}” can only be ${plan.dateFormat.detected === "dmy" ? "day first" : "month first"}, so we've chosen that. A date like 10/01/2026 will be read the same way.`
                    : "We couldn't tell from the file. Dates like 10/01/2026 will be skipped until you choose."}
              </p>
              <NativeSelect
                id="date-order"
                className="mt-2 w-72"
                value={decisions.dateOrder ?? ""}
                onChange={(e) => setDecisions({ ...decisions, dateOrder: (e.target.value || null) as DateOrder | null })}
              >
                <NativeSelectOption value="">Not sure: skip ambiguous dates</NativeSelectOption>
                <NativeSelectOption value="dmy">Day first (DD/MM/YYYY)</NativeSelectOption>
                <NativeSelectOption value="mdy">Month first (MM/DD/YYYY)</NativeSelectOption>
              </NativeSelect>
            </div>

            <div className="flex items-center justify-between gap-4">
              <Button variant="ghost" onClick={() => setStep("upload")}>
                Choose another file
              </Button>
              <div className="flex items-center gap-3">
                {missingRequired.length > 0 && (
                  <span className="text-sm text-destructive">Match: {missingRequired.map((f) => f.label).join(", ")}</span>
                )}
                <Button onClick={() => preview()} disabled={busy || missingRequired.length > 0}>
                  {busy && <Loader2Icon className="animate-spin" />} Preview import
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && plan && (
        <Preview
          plan={plan}
          decisions={decisions}
          busy={busy}
          fileName={fileName}
          onDecide={decide}
          onBack={() => setStep("map")}
          onCommit={commit}
        />
      )}

      {step === "done" && result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="size-5 text-emerald-600" /> Imported {fileName}
            </CardTitle>
            <CardDescription>
              {result.owners.create} owners added, {result.owners.update} updated; {result.receivables.create} receivables
              added, {result.receivables.update} updated; {result.skipped} rows skipped.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button asChild>
              <Link href="/owners">Go to owners</Link>
            </Button>
            <Button variant="outline" onClick={() => setStep("upload")}>
              Import another file
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const steps: [Step, string][] = [
    ["upload", "Upload"],
    ["map", "Match columns"],
    ["preview", "Preview"],
    ["done", "Done"],
  ];
  const current = steps.findIndex(([s]) => s === step);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
              i <= current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {i + 1}
          </span>
          <span className={i === current ? "font-medium" : "text-muted-foreground"}>{label}</span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

function Upload({ onLoad }: { onLoad: (name: string, text: string) => void }) {
  async function sample(file: "first" | "update") {
    const res = await api<{ name: string; csv: string }>(`/api/import/sample?file=${file}`);
    onLoad(res.name, res.csv);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload an export</CardTitle>
        <CardDescription>A CSV from the managing agent's accounts system: one row per demand.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center hover:bg-muted/40">
          <FileUpIcon className="size-8 text-muted-foreground" />
          <span className="font-medium">Choose a CSV file</span>
          <span className="text-sm text-muted-foreground">Nothing is saved until you confirm the preview.</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) onLoad(file.name, await file.text());
              e.target.value = "";
            }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Or use a sample:
          <Button variant="outline" size="sm" onClick={() => sample("first")}>
            owners-and-receivables.csv
          </Button>
          <Button variant="outline" size="sm" onClick={() => sample("update")}>
            owners-and-receivables-update.csv
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" && value > 0 ? "text-amber-600" : ""}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Preview({
  plan,
  decisions,
  busy,
  fileName,
  onDecide,
  onBack,
  onCommit,
}: {
  plan: ImportPlan;
  decisions: Decisions;
  busy: boolean;
  fileName: string;
  onDecide: (d: Decisions) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const c = plan.counts;
  const undecided = plan.mergeSuggestions.filter((m) => !m.decision).length;
  const changedOwners = plan.owners.filter((o) => o.status !== "unchanged" || !o.emailUsable || o.warnings.length);
  const changedReceivables = plan.receivables.filter((r) => r.status !== "unchanged");

  function downloadSkipped() {
    const rows = [[...plan.headers, "Skipped because"], ...plan.skipped.map((s) => [...s.cells, s.reasons.join("; ")])];
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.csv$/i, "") + "-skipped.csv";
    a.click();
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Owners" value={c.owners.create + c.owners.update} sub={`${c.owners.create} new · ${c.owners.update} updated · ${c.owners.unchanged} no change`} />
        <Stat label="Units" value={c.units.create + c.units.update} sub={`${c.units.create} new · ${c.units.update} updated · ${c.units.unchanged} no change`} />
        <Stat label="Receivables" value={c.receivables.create + c.receivables.update} sub={`${c.receivables.create} new · ${c.receivables.update} updated · ${c.receivables.unchanged} no change`} />
        <Stat label="Rows skipped" value={c.skipped} sub={`of ${plan.rowCount} rows`} tone="warn" />
        <Stat label="No usable email" value={c.noUsableEmail} sub="automations can't reach them" tone="warn" />
      </div>

      {plan.mergeSuggestions.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UsersIcon className="size-4" /> Are these the same person?
            </CardTitle>
            <CardDescription>
              Nothing is merged unless you say so. Sharing an email address is never enough on its own: couples and families share inboxes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {plan.mergeSuggestions.map((m) => (
              <div key={m.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    {m.members.map((mem) => (
                      <div key={mem.key} className="text-sm">
                        <span className="font-medium">{mem.name}</span>{" "}
                        <span className="text-muted-foreground">
                          {mem.email ?? "no email"} · {mem.units.join(", ")}
                          {mem.existingOwnerId ? " · already in Levyline" : mem.lines.length ? ` · rows ${mem.lines.join(", ")}` : ""}
                        </span>
                      </div>
                    ))}
                    <div className="text-xs text-muted-foreground">Why: {m.reasons.join(", ")}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={m.decision === "merge" ? "default" : "outline"}
                      onClick={() => onDecide({ ...decisions, merges: { ...decisions.merges, [m.id]: "merge" } })}
                    >
                      Same person: merge
                    </Button>
                    <Button
                      size="sm"
                      variant={m.decision === "separate" ? "default" : "outline"}
                      onClick={() => onDecide({ ...decisions, merges: { ...decisions.merges, [m.id]: "separate" } })}
                    >
                      Different people
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {plan.missingUnits.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArchiveIcon className="size-4" /> Units missing from this file
            </CardTitle>
            <CardDescription>
              These are in Levyline but not in this export. Archive them to take them (and their balances) out of chasing; leave them to keep them as they are.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {plan.missingUnits.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={decisions.archiveUnitIds.includes(u.id)}
                  onCheckedChange={(checked) =>
                    onDecide({
                      ...decisions,
                      archiveUnitIds: checked
                        ? [...decisions.archiveUnitIds, u.id]
                        : decisions.archiveUnitIds.filter((id) => id !== u.id),
                    })
                  }
                />
                Archive {u.label}
              </label>
            ))}
          </CardContent>
        </Card>
      )}

      {plan.skipped.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <AlertTriangleIcon className="size-4 text-amber-600" /> Rows that won't be imported
              </CardTitle>
              <CardDescription>We don't guess numbers or dates. Fix these in the accounts system and re-import, or download them.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={downloadSkipped}>
              <DownloadIcon /> Download skipped rows
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Row</TableHead>
                  <TableHead className="w-24">Demand</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.skipped.map((s) => (
                  <TableRow key={s.line}>
                    <TableCell className="tabular-nums">{s.line}</TableCell>
                    <TableCell>{s.demandRef}</TableCell>
                    <TableCell className="whitespace-normal">{s.reasons.join("; ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SparklesIcon className="size-4" /> What we tidied
            </CardTitle>
            <CardDescription>Changes that don't alter meaning.</CardDescription>
          </CardHeader>
          <CardContent>
            {plan.tidied.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing needed tidying.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {plan.tidied.map((t, i) => (
                  <li key={i}>
                    {t.line && <span className="mr-2 text-muted-foreground tabular-nums">Row {t.line}</span>}
                    {t.text}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailWarningIcon className="size-4" /> Worth knowing
            </CardTitle>
            <CardDescription>Imported, but check these.</CardDescription>
          </CardHeader>
          <CardContent>
            {plan.warnings.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing to flag.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {plan.warnings.map((w, i) => (
                  <li key={i}>
                    {w.line && <span className="mr-2 text-muted-foreground tabular-nums">Row {w.line}</span>}
                    {w.text}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Owners</CardTitle>
          <CardDescription>
            New and changed owners, and anyone with something to check. A field you've edited in Levyline is only overwritten if the file itself changed it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Owner</TableHead>
                <TableHead className="w-28"></TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Changes and notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changedOwners.map((o) => (
                <TableRow key={o.ref}>
                  <TableCell className="font-medium">
                    {o.values.fullName}
                    <div className="flex flex-wrap gap-1 pt-1">
                      {o.values.doNotContact && <Badge variant="destructive">Do not contact</Badge>}
                      {o.values.deceased && <Badge variant="destructive">Deceased</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={o.status === "create" ? "default" : o.status === "update" ? "secondary" : "outline"}>
                      {STATUS_LABEL[o.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {o.emailUsable ? (
                      o.values.email
                    ) : (
                      <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">
                        No usable email
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal text-sm">
                    {o.changes.map((ch, i) => (
                      <div key={i}>
                        {ch.field}: <span className="text-muted-foreground line-through">{ch.from ?? "blank"}</span> → {ch.to ?? "blank"}
                      </div>
                    ))}
                    {o.warnings.map((w, i) => (
                      <div key={i} className="text-muted-foreground">
                        {w}
                      </div>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {changedReceivables.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Receivables</CardTitle>
            <CardDescription>New and changed demands.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Demand</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changedReceivables.map((r) => (
                  <TableRow key={`${r.clientName}|${r.demandRef}`}>
                    <TableCell>{r.demandRef}</TableCell>
                    <TableCell>{r.values.unitKey.split("|")[2]}</TableCell>
                    <TableCell>
                      {r.values.kind}
                      {r.setDisputed && <Badge variant="destructive" className="ml-2">Disputed</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{(r.values.amountCents / 100).toFixed(2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{(r.values.paidCents / 100).toFixed(2)}</TableCell>
                    <TableCell className="tabular-nums">{r.values.dueDate}</TableCell>
                    <TableCell className="whitespace-normal text-sm">
                      {r.status === "create" ? (
                        <Badge>New</Badge>
                      ) : (
                        r.changes.map((ch, i) => (
                          <div key={i}>
                            {ch.field.replace("Cents", "")}: <span className="text-muted-foreground line-through">{ch.from ?? "blank"}</span> → {ch.to ?? "blank"}
                          </div>
                        ))
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="sticky bottom-0 -mx-6 flex items-center justify-between gap-4 border-t bg-background/95 px-6 py-4 backdrop-blur md:-mx-10 md:px-10">
        <Button variant="ghost" onClick={onBack}>
          Back to columns
        </Button>
        <div className="flex items-center gap-3">
          {undecided > 0 && (
            <Alert className="border-0 p-0">
              <AlertTitle className="text-sm text-amber-700 dark:text-amber-400">
                Decide on {undecided} possible duplicate{undecided > 1 ? "s" : ""} first
              </AlertTitle>
              <AlertDescription className="sr-only">Every suggestion needs a decision</AlertDescription>
            </Alert>
          )}
          <Button onClick={onCommit} disabled={busy || !plan.ready}>
            {busy && <Loader2Icon className="animate-spin" />} Import
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  FlagIcon,
  GitBranchIcon,
  Loader2Icon,
  MailIcon,
  PauseIcon,
  PlayIcon,
  PowerOffIcon,
  SaveIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/client";
import {
  CONDITIONS,
  canonical,
  KNOWN_PLACEHOLDERS,
  stepLabel,
  validateGraph,
  type Condition,
  type Graph,
  type GraphNode,
  type StepData,
  type StepType,
} from "@/lib/automation/graph";
import { formatEuro } from "@/lib/time";

type FlowData = StepData & { problem?: string };
type FlowNode = Node<FlowData, StepType>;

const ICONS = { start: PlayIcon, end: FlagIcon, email: MailIcon, wait: ClockIcon, branch: GitBranchIcon };

function Shell({ type, data, selected, children }: { type: StepType; data: FlowData; selected: boolean; children?: React.ReactNode }) {
  const Icon = ICONS[type];
  const label = stepLabel({ id: "", type, position: { x: 0, y: 0 }, data });
  return (
    <div
      className={`w-56 rounded-xl border bg-card px-3 py-2 text-card-foreground shadow-sm ${selected ? "ring-2 ring-primary" : ""} ${
        data.problem ? "border-destructive ring-1 ring-destructive/50" : ""
      } ${type === "start" || type === "end" ? "w-36 text-center" : ""}`}
      title={data.problem}
    >
      <div className={`flex items-center gap-2 text-sm font-medium ${type === "start" || type === "end" ? "justify-center" : ""}`}>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </div>
      {children}
    </div>
  );
}

const nodeTypes = {
  start: ({ data, selected }: NodeProps<FlowNode>) => (
    <>
      <Shell type="start" data={data} selected={selected} />
      <Handle type="source" position={Position.Bottom} />
    </>
  ),
  end: ({ data, selected }: NodeProps<FlowNode>) => (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell type="end" data={data} selected={selected} />
    </>
  ),
  email: ({ data, selected }: NodeProps<FlowNode>) => (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell type="email" data={data} selected={selected}>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{data.body || "No message yet"}</p>
      </Shell>
      <Handle type="source" position={Position.Bottom} />
    </>
  ),
  wait: ({ data, selected }: NodeProps<FlowNode>) => (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell type="wait" data={data} selected={selected} />
      <Handle type="source" position={Position.Bottom} />
    </>
  ),
  branch: ({ data, selected }: NodeProps<FlowNode>) => (
    <>
      <Handle type="target" position={Position.Top} />
      <Shell type="branch" data={data} selected={selected}>
        <div className="mt-1 flex justify-between text-xs font-medium">
          <span className="text-emerald-600">Yes</span>
          <span className="text-rose-600">No</span>
        </div>
      </Shell>
      <Handle id="yes" type="source" position={Position.Bottom} style={{ left: "20%", background: "#059669" }} />
      <Handle id="no" type="source" position={Position.Bottom} style={{ left: "80%", background: "#e11d48" }} />
    </>
  ),
};

const LIBRARY: { type: StepType; label: string; hint: string }[] = [
  { type: "email", label: "Send email", hint: "From a template you can edit" },
  { type: "wait", label: "Wait", hint: "A number of minutes" },
  { type: "branch", label: "Branch", hint: "Yes/no question about the owner" },
  { type: "end", label: "End", hint: "The owner is finished" },
];

function defaults(type: StepType, templates: Template[]): StepData {
  if (type === "email") {
    const t = templates.find((x) => x.id === "friendly-reminder") ?? templates[0];
    return { templateId: t?.id, subject: t?.subject ?? "", body: t?.body ?? "" };
  }
  if (type === "wait") return { minutes: 60 * 24 * 7 };
  if (type === "branch") return { condition: "has_replied" };
  return {};
}

const edgeStyle = (handle?: string | null): Partial<Edge> => ({
  markerEnd: { type: MarkerType.ArrowClosed },
  label: handle === "yes" ? "Yes" : handle === "no" ? "No" : undefined,
  style: handle === "yes" ? { stroke: "#059669" } : handle === "no" ? { stroke: "#e11d48" } : undefined,
});

export type Template = { id: string; subject: string; body: string };
export type AutomationProps = {
  id: string;
  name: string;
  clientId: string | null;
  status: "draft" | "live" | "paused";
  graph: Graph;
  liveGraph: Graph | null;
  counts: Record<string, number>;
  clients: { id: string; name: string }[];
  templates: Template[];
  owners: { id: string; name: string }[];
};

export function AutomationCanvas(props: AutomationProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor(props: AutomationProps) {
  const router = useRouter();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(props.graph.nodes as FlowNode[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(props.graph.edges.map((e) => ({ ...e, ...edgeStyle(e.sourceHandle) })));
  const [name, setName] = useState(props.name);
  const [clientId, setClientId] = useState(props.clientId ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saved, setSaved] = useState(canonical(props.graph) + props.name + (props.clientId ?? ""));
  const [busy, setBusy] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);

  const graph: Graph = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ id: n.id, type: n.type as StepType, position: n.position, data: stripProblem(n.data) })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
    }),
    [nodes, edges],
  );
  const problems = useMemo(() => validateGraph(graph), [graph]);
  const dirty = saved !== canonical(graph) + name + clientId;
  const unpublished = props.status !== "draft" && props.liveGraph && canonical(props.liveGraph) !== canonical(graph);

  const displayNodes = useMemo(() => {
    const byNode = new Map(problems.filter((p) => p.nodeId).map((p) => [p.nodeId!, p.message]));
    return nodes.map((n) => ({ ...n, data: { ...n.data, problem: showProblems ? byNode.get(n.id) : undefined } }));
  }, [nodes, problems, showProblems]);

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) => {
        // One edge per exit: reconnecting an exit replaces its old edge.
        const kept = eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
        return addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle ?? "out"}-${c.target}`, ...edgeStyle(c.sourceHandle) }, kept);
      });
    },
    [setEdges],
  );

  function addNode(type: StepType, position?: { x: number; y: number }) {
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    const steps = nodes.filter((n) => n.type !== "end");
    const lowest = steps.reduce((a, n) => (n.position.y > a.position.y ? n : a), steps[0] ?? nodes[0]);
    const pos = position ?? { x: lowest?.position.x ?? 0, y: (lowest?.position.y ?? 0) + 120 };
    setNodes((ns) => [...ns, { id, type, position: pos, data: defaults(type, props.templates) }]);
    setSelectedId(id);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/levyline-step") as StepType;
    if (!type) return;
    addNode(type, flow.screenToFlowPosition({ x: event.clientX - 100, y: event.clientY - 20 }));
  }

  function updateData(id: string, patch: Partial<StepData>) {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  async function save(quiet = false) {
    setBusy(true);
    try {
      await api(`/api/automations/${props.id}`, { method: "PUT", body: { name, clientId: clientId || null, graph } });
      setSaved(canonical(graph) + name + clientId);
      if (!quiet) toast.success("Saved");
      router.refresh();
      return true;
    } catch (error) {
      toast.error((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "live" | "paused" | "draft") {
    if (status === "live") {
      setShowProblems(true);
      if (problems.length || !clientId) {
        toast.error(!clientId ? "Choose a client first" : "Fix the problems listed before turning it on");
        return;
      }
      if (!(await save(true))) return;
    }
    setBusy(true);
    try {
      await api(`/api/automations/${props.id}/status`, { body: { status } });
      toast.success(status === "live" ? "Automation is on" : status === "paused" ? "Paused: nobody moves on until you resume" : "Turned off; owners removed");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError && error.errors.length ? error.errors.join("; ") : (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-56" aria-label="Automation name" />
        <NativeSelect size="sm" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client" disabled={props.status !== "draft"}>
          <NativeSelectOption value="">Choose a client…</NativeSelectOption>
          {props.clients.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Badge variant={props.status === "live" ? "default" : props.status === "paused" ? "outline" : "secondary"}>
          {props.status === "live" ? "On" : props.status === "paused" ? "Paused" : "Draft"}
        </Badge>
        {Object.entries(props.counts).map(([state, n]) => (
          <span key={state} className="text-xs text-muted-foreground">
            {n} {state}
          </span>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
          {!dirty && unpublished && <span className="text-xs text-amber-600">Saved; turn on again to use these changes for new owners</span>}
          <Button size="sm" variant="outline" onClick={() => setShowProblems(true)}>
            {problems.length ? <CircleAlertIcon className="text-destructive" /> : <CheckCircle2Icon className="text-emerald-600" />}
            Check
          </Button>
          <Button size="sm" variant="outline" onClick={() => save()} disabled={busy}>
            <SaveIcon /> Save
          </Button>
          {props.status !== "live" ? (
            <Button size="sm" onClick={() => setStatus("live")} disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} {props.status === "paused" ? "Resume" : "Turn on"}
            </Button>
          ) : (
            <>
              {unpublished && (
                <Button size="sm" onClick={() => setStatus("live")} disabled={busy}>
                  Publish changes
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setStatus("paused")} disabled={busy}>
                <PauseIcon /> Pause
              </Button>
            </>
          )}
          {props.status !== "draft" && (
            <Button size="sm" variant="ghost" onClick={() => setStatus("draft")} disabled={busy} title="Turn off and remove every owner">
              <PowerOffIcon /> Turn off
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setEnrollOpen(true)} disabled={props.status !== "live"} title={props.status !== "live" ? "Turn it on first" : undefined}>
            <UserPlusIcon /> Add owners
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* Step library */}
        <aside className="w-52 shrink-0 space-y-2 border-r bg-muted/30 p-3">
          <div className="text-xs font-medium text-muted-foreground">Steps: drag onto the canvas</div>
          {LIBRARY.map((item) => {
            const Icon = ICONS[item.type];
            return (
              <div
                key={item.type}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/levyline-step", item.type);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDoubleClick={() => addNode(item.type)}
                className="cursor-grab rounded-lg border bg-card p-2 text-sm shadow-xs active:cursor-grabbing"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Icon className="size-4 text-muted-foreground" />
                  {item.label}
                </div>
                <div className="text-xs text-muted-foreground">{item.hint}</div>
                <button className="mt-1 text-xs text-primary underline-offset-2 hover:underline" onClick={() => addNode(item.type)}>
                  Add
                </button>
              </div>
            );
          })}
          {showProblems && (
            <div className="space-y-1 pt-3">
              <div className="text-xs font-medium text-muted-foreground">{problems.length ? "To fix before turning on" : "Ready to turn on"}</div>
              {problems.map((p, i) => (
                <button
                  key={i}
                  className="block w-full rounded-md bg-destructive/10 px-2 py-1 text-left text-xs text-destructive"
                  onClick={() => p.nodeId && setSelectedId(p.nodeId)}
                >
                  {p.message}
                </button>
              ))}
              {!clientId && <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">Choose which client this chases for</div>}
            </div>
          )}
        </aside>

        {/* Canvas */}
        <div ref={wrapper} className="min-w-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            attributionPosition="bottom-left"
          >
            <Background gap={20} />
            <Controls />
          </ReactFlow>
        </div>

        {/* Inspector */}
        {selected && (
          <aside className="w-96 shrink-0 space-y-4 overflow-y-auto border-l bg-background p-4">
            <Inspector
              key={selected.id}
              automationId={props.id}
              node={selected as unknown as GraphNode}
              templates={props.templates}
              owners={props.owners}
              clientChosen={Boolean(clientId) && clientId === props.clientId}
              onChange={(patch) => updateData(selected.id, patch)}
              onDelete={() => {
                setNodes((ns) => ns.filter((n) => n.id !== selected.id));
                setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
                setSelectedId(null);
              }}
            />
          </aside>
        )}
      </div>

      <EnrollDialog automationId={props.id} open={enrollOpen} onOpenChange={setEnrollOpen} />
    </div>
  );
}

function stripProblem(data: FlowData): StepData {
  const rest = { ...data };
  delete rest.problem;
  return rest;
}

function Inspector({
  automationId,
  node,
  templates,
  owners,
  clientChosen,
  onChange,
  onDelete,
}: {
  automationId: string;
  node: GraphNode;
  templates: Template[];
  owners: { id: string; name: string }[];
  clientChosen: boolean;
  onChange: (patch: Partial<StepData>) => void;
  onDelete: () => void;
}) {
  const [ownerId, setOwnerId] = useState(owners[0]?.id ?? "");
  const [preview, setPreview] = useState<{ subject: string; body: string; missing: string[]; note: string | null } | null>(null);
  const d = node.data;

  async function runPreview() {
    try {
      setPreview(
        await api(`/api/automations/${automationId}/preview`, { body: { ownerId, subject: d.subject ?? "", body: d.body ?? "" } }),
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{stepLabel(node)}</h3>
        {node.type !== "start" && (
          <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="Delete step">
            <Trash2Icon />
          </Button>
        )}
      </div>

      {node.type === "start" && <p className="text-sm text-muted-foreground">Every owner you add starts here. Connect it to the first step.</p>}
      {node.type === "end" && <p className="text-sm text-muted-foreground">Owners who reach this are finished with the automation.</p>}

      {node.type === "wait" && (
        <div className="space-y-1">
          <Label htmlFor="wait-min">Wait for (minutes)</Label>
          <Input
            id="wait-min"
            type="number"
            min={1}
            value={d.minutes ?? ""}
            onChange={(e) => onChange({ minutes: e.target.value === "" ? undefined : Math.round(Number(e.target.value)) })}
          />
          <div className="flex flex-wrap gap-1 pt-1">
            {[
              [5, "5 min"],
              [60, "1 hour"],
              [1440, "1 day"],
              [10080, "1 week"],
            ].map(([m, l]) => (
              <Button key={m} size="xs" variant="outline" onClick={() => onChange({ minutes: m as number })}>
                {l}
              </Button>
            ))}
          </div>
          <p className="pt-1 text-xs text-muted-foreground">Measured on the app clock, which can be sped up in Settings for testing.</p>
        </div>
      )}

      {node.type === "branch" && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="br-cond">Question</Label>
            <NativeSelect id="br-cond" className="w-full" value={d.condition ?? ""} onChange={(e) => onChange({ condition: e.target.value as Condition })}>
              {Object.entries(CONDITIONS).map(([k, v]) => (
                <NativeSelectOption key={k} value={k}>
                  {v}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {d.condition === "balance_over" && (
            <div className="space-y-1">
              <Label htmlFor="br-th">Balance over (€)</Label>
              <Input id="br-th" type="number" min={1} value={d.threshold ?? ""} onChange={(e) => onChange({ threshold: Number(e.target.value) })} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Answered from the owner's data at the moment they reach this step. “Has replied” means since they were added to this automation; balance is what they owe this automation's client.
          </p>
        </div>
      )}

      {node.type === "email" && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="em-tpl">Template</Label>
            <NativeSelect
              id="em-tpl"
              className="w-full"
              value={d.templateId ?? ""}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value);
                if (t) onChange({ templateId: t.id, subject: t.subject, body: t.body });
              }}
            >
              {templates
                .filter((t) => t.id !== "commitment-confirmation")
                .map((t) => (
                  <NativeSelectOption key={t.id} value={t.id}>
                    {t.id.replace(/-/g, " ")}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="em-subj">Subject</Label>
            <Input id="em-subj" value={d.subject ?? ""} onChange={(e) => onChange({ subject: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="em-body">Message</Label>
            <Textarea id="em-body" rows={10} value={d.body ?? ""} onChange={(e) => onChange({ body: e.target.value })} />
            <p className="text-xs text-muted-foreground">Placeholders: {KNOWN_PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ")}</p>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <Label>Preview with a real owner</Label>
            {!clientChosen ? (
              <p className="text-xs text-muted-foreground">Choose the client and save first.</p>
            ) : (
              <>
                <div className="flex gap-2">
                  <NativeSelect size="sm" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner to preview with">
                    {owners.map((o) => (
                      <NativeSelectOption key={o.id} value={o.id}>
                        {o.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button size="sm" variant="outline" onClick={runPreview}>
                    Preview
                  </Button>
                </div>
                {preview && (
                  <div className="space-y-1 text-sm">
                    {preview.note && <p className="text-xs text-amber-700">{preview.note}</p>}
                    {preview.missing.length > 0 && (
                      <p className="text-xs text-destructive">No value for {preview.missing.map((m) => `{{${m}}}`).join(", ")}</p>
                    )}
                    <div className="font-medium">{preview.subject}</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{preview.body}</div>
                  </div>
                )}
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Sent only Mon–Sat 08:00–20:00 Irish time, at most one automated email per owner per day, and never to do not contact, zero balances, disputed or not-yet-due receivables.
          </p>
        </div>
      )}
    </>
  );
}

type Candidate = { id: string; name: string; enrolled: boolean; balanceCents: number; eligible: boolean; note: string | null };

function EnrollDialog({ automationId, open, onOpenChange }: { automationId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [owners, setOwners] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    setOwners(null);
    try {
      const res = await api<{ owners: Candidate[] }>(`/api/automations/${automationId}/enroll`);
      setOwners(res.owners);
      setChosen(res.owners.filter((o) => !o.enrolled && o.eligible).map((o) => o.id));
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function add() {
    setBusy(true);
    try {
      const res = await api<{ results: { added: boolean }[] }>(`/api/automations/${automationId}/enroll`, { body: { ownerIds: chosen } });
      toast.success(`Added ${res.results.filter((r) => r.added).length} owners`);
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add owners</DialogTitle>
          <DialogDescription>
            Each owner moves through on their own. Anyone the rules hold back can still be added; their page will say why they're waiting.
          </DialogDescription>
        </DialogHeader>
        {!owners ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            <label className="flex items-center gap-2 border-b pb-2 text-sm font-medium">
              <Checkbox
                checked={chosen.length === owners.filter((o) => !o.enrolled).length && chosen.length > 0}
                onCheckedChange={(c) => setChosen(c ? owners.filter((o) => !o.enrolled).map((o) => o.id) : [])}
              />
              Everyone not already in it
            </label>
            {owners.map((o) => (
              <label key={o.id} className={`flex items-center gap-2 text-sm ${o.enrolled ? "opacity-50" : ""}`}>
                <Checkbox
                  disabled={o.enrolled}
                  checked={chosen.includes(o.id)}
                  onCheckedChange={(c) => setChosen(c ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))}
                />
                <span className="flex-1">
                  {o.name}
                  {o.enrolled ? <span className="text-muted-foreground"> · already in it</span> : o.note && <span className="text-xs text-muted-foreground"> · {o.note}</span>}
                </span>
                <span className="tabular-nums">{formatEuro(o.balanceCents)}</span>
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button onClick={add} disabled={busy || chosen.length === 0}>
            Add {chosen.length} owner{chosen.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

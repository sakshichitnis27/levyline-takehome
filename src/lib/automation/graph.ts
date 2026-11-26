// The shape of an automation and the checks it must pass before going live.
// Shared by the canvas (to show what to fix) and the server (to refuse).

export type StepType = "start" | "end" | "email" | "wait" | "branch";
export type Condition = "has_replied" | "has_commitment" | "balance_over";

export type StepData = {
  templateId?: string;
  subject?: string;
  body?: string;
  minutes?: number;
  condition?: Condition;
  threshold?: number; // euros, for balance_over
};

export type GraphNode = { id: string; type: StepType; position: { x: number; y: number }; data: StepData };
export type GraphEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export const CONDITIONS: Record<Condition, string> = {
  has_replied: "Has replied?",
  has_commitment: "Has a commitment?",
  balance_over: "Balance over €…?",
};

export const KNOWN_PLACEHOLDERS = [
  "owner_first_name",
  "balance",
  "unit_refs",
  "development_name",
  "client_name",
  "oldest_due_date",
];

export function stepLabel(node: GraphNode | undefined): string {
  if (!node) return "a removed step";
  switch (node.type) {
    case "start":
      return "Start";
    case "end":
      return "End";
    case "email":
      return `Send "${node.data.subject || "email"}"`;
    case "wait":
      return `Wait ${node.data.minutes ?? "?"} min`;
    case "branch":
      return node.data.condition === "balance_over"
        ? `Balance over €${node.data.threshold ?? "?"}?`
        : CONDITIONS[node.data.condition ?? "has_replied"];
  }
}

export type GraphProblem = { nodeId?: string; message: string };

export function validateGraph(graph: Graph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = (id: string) => edges.filter((e) => e.source === id && byId.has(e.target));
  const into = (id: string) => edges.filter((e) => e.target === id && byId.has(e.source));

  const starts = nodes.filter((n) => n.type === "start");
  const ends = nodes.filter((n) => n.type === "end");
  if (starts.length !== 1) problems.push({ message: starts.length ? "There can only be one Start" : "Add a Start step" });
  if (ends.length === 0) problems.push({ message: "Add an End step" });
  if (!nodes.some((n) => n.type === "email")) problems.push({ message: "Add at least one Send email step" });

  for (const node of nodes) {
    const label = stepLabel(node);
    const outs = out(node.id);
    if (node.type !== "start" && into(node.id).length === 0) {
      problems.push({ nodeId: node.id, message: `${label} isn't connected to anything before it` });
    }
    if (node.type === "start" && into(node.id).length) problems.push({ nodeId: node.id, message: "Nothing can lead into Start" });
    if (node.type === "end" && outs.length) problems.push({ nodeId: node.id, message: "End can't lead anywhere" });
    if (["start", "email", "wait"].includes(node.type) && outs.length !== 1) {
      problems.push({
        nodeId: node.id,
        message: outs.length ? `${label} must lead to exactly one next step` : `${label} is a dead end: connect it to a next step`,
      });
    }
    if (node.type === "branch") {
      const yes = outs.filter((e) => e.sourceHandle === "yes").length;
      const no = outs.filter((e) => e.sourceHandle === "no").length;
      if (yes !== 1) problems.push({ nodeId: node.id, message: `${label}: connect the Yes exit${yes > 1 ? " to only one step" : ""}` });
      if (no !== 1) problems.push({ nodeId: node.id, message: `${label}: connect the No exit${no > 1 ? " to only one step" : ""}` });
      if (!node.data.condition) problems.push({ nodeId: node.id, message: "Choose the question this Branch asks" });
      if (node.data.condition === "balance_over" && !(Number(node.data.threshold) > 0)) {
        problems.push({ nodeId: node.id, message: `${label}: set the balance amount` });
      }
    }
    if (node.type === "email") {
      if (!node.data.subject?.trim()) problems.push({ nodeId: node.id, message: `${label}: the subject is empty` });
      if (!node.data.body?.trim()) problems.push({ nodeId: node.id, message: `${label}: the message is empty` });
      const used = [...`${node.data.subject ?? ""} ${node.data.body ?? ""}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      const unknown = [...new Set(used.filter((u) => !KNOWN_PLACEHOLDERS.includes(u)))];
      if (unknown.length) {
        problems.push({ nodeId: node.id, message: `${label}: unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(", ")}` });
      }
    }
    if (node.type === "wait" && !(Number.isInteger(node.data.minutes) && node.data.minutes! > 0)) {
      problems.push({ nodeId: node.id, message: "Wait: set a whole number of minutes" });
    }
  }

  // Everything reachable from Start, every path ends, and no loops.
  if (starts.length === 1) {
    const state = new Map<string, "visiting" | "done">();
    let cycle = false;
    const visit = (id: string) => {
      if (state.get(id) === "visiting") {
        cycle = true;
        return;
      }
      if (state.get(id) === "done") return;
      state.set(id, "visiting");
      for (const e of out(id)) visit(e.target);
      state.set(id, "done");
    };
    visit(starts[0].id);
    if (cycle) problems.push({ message: "The automation loops back on itself; owners must always reach an End" });
    for (const node of nodes) {
      if (!state.has(node.id) && node.type !== "start") {
        problems.push({ nodeId: node.id, message: `${stepLabel(node)} can't be reached from Start` });
      }
    }
  }
  // De-duplicate identical messages (e.g. one disconnected node reported twice).
  return problems.filter((p, i) => problems.findIndex((q) => q.message === p.message && q.nodeId === p.nodeId) === i);
}

/** JSON with sorted keys, so graphs compare equal however Postgres ordered them. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))
      : v,
  );
}

export function nextNode(graph: Graph, nodeId: string, handle?: "yes" | "no"): string | null {
  const edge = graph.edges.find((e) => e.source === nodeId && (!handle || e.sourceHandle === handle));
  return edge?.target ?? null;
}

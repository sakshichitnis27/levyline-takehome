// Filling {{placeholders}} in email templates from an owner's data.

import { formatDate, formatEuro } from "@/lib/time";

export type TemplateContext = Record<string, string>;

export const PLACEHOLDER_HELP: Record<string, string> = {
  owner_first_name: "The owner's first name",
  balance: "What's being asked for, e.g. €1,150.00",
  unit_refs: "The units, e.g. HA-A03 and HA-B01",
  development_name: "The development(s)",
  client_name: "The managing agent",
  oldest_due_date: "Due date of the oldest receivable",
  commitment_schedule: "The payment plan, one line per payment",
};

function list(items: string[]): string {
  const unique = [...new Set(items)];
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

export function buildContext(input: {
  ownerName: string;
  clientName: string;
  receivables: { unitRef: string; developmentName: string; dueDate: string; outstandingCents: number }[];
  balanceCents?: number;
  schedule?: { dueDate: string; amountCents: number }[];
}): TemplateContext {
  const { receivables } = input;
  const balance = input.balanceCents ?? receivables.reduce((sum, r) => sum + r.outstandingCents, 0);
  const oldest = receivables.map((r) => r.dueDate).sort()[0];
  return {
    owner_first_name: input.ownerName.split(" ")[0] ?? input.ownerName,
    balance: formatEuro(balance),
    unit_refs: list(receivables.map((r) => r.unitRef)) || "your unit",
    development_name: list(receivables.map((r) => r.developmentName)) || "your development",
    client_name: input.clientName,
    oldest_due_date: oldest ? formatDate(oldest) : "",
    commitment_schedule: (input.schedule ?? [])
      .map((s, i) => `${i + 1}. ${formatEuro(s.amountCents)} on ${formatDate(s.dueDate)}`)
      .join("\n"),
  };
}

export function render(text: string, context: TemplateContext): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = context[key];
    if (value === undefined || value === "") {
      missing.push(key);
      return match;
    }
    return value;
  });
  return { text: out, missing: [...new Set(missing)] };
}

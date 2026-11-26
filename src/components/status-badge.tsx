import { Badge } from "@/components/ui/badge";

const TONE: Record<string, "destructive" | "secondary" | "outline" | "default"> = {
  "Do not contact": "destructive",
  Deceased: "destructive",
  "Commitment broken": "destructive",
  "In dispute": "outline",
  "Commitment active": "default",
  "In automation": "secondary",
  "Automation paused": "outline",
  "Sold unit": "outline",
  "No usable email": "outline",
  "No current units": "outline",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? "secondary";
  const warn = status === "In dispute" || status === "No usable email" || status === "Automation paused";
  return (
    <Badge variant={tone} className={warn ? "border-amber-400 text-amber-700 dark:text-amber-400" : undefined}>
      {status}
    </Badge>
  );
}

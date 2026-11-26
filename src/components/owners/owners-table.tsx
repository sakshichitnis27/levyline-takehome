"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OwnerListRow } from "@/lib/owners";
import { formatDateTime, formatEuro } from "@/lib/time";

type Sort = "name" | "balance" | "lastMessage";

const FILTERS = [
  "Do not contact",
  "Deceased",
  "In dispute",
  "Commitment active",
  "Commitment broken",
  "In automation",
  "Automation paused",
  "Sold unit",
  "No usable email",
  "No phone",
];

export function OwnersTable({ owners }: { owners: OwnerListRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("balance");
  const [desc, setDesc] = useState(true);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = owners.filter((o) => {
      if (q && ![o.name, o.email ?? "", o.phone ?? "", ...o.units, ...o.developments].join(" ").toLowerCase().includes(q)) return false;
      if (filter === "No usable email") return !o.emailUsable;
      if (filter === "No phone") return !o.phone;
      if (filter) return o.statuses.includes(filter);
      return true;
    });
    const value = (o: OwnerListRow) =>
      sort === "balance" ? o.balanceCents : sort === "lastMessage" ? (o.lastMessageAt ? Date.parse(o.lastMessageAt) : -Infinity) : o.name;
    return list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return desc ? -cmp : cmp;
    });
  }, [owners, query, filter, sort, desc]);

  function header(label: string, key: Sort, className?: string) {
    const active = sort === key;
    return (
      <TableHead className={className}>
        <button
          className="inline-flex items-center gap-1 hover:text-foreground"
          onClick={() => {
            if (active) setDesc(!desc);
            else {
              setSort(key);
              setDesc(key !== "name");
            }
          }}
        >
          {label}
          {active && (desc ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
        </button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search name, email, phone, unit…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
          <NativeSelectOption value="">Everyone</NativeSelectOption>
          {FILTERS.map((f) => (
            <NativeSelectOption key={f} value={f}>
              {f}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-sm text-muted-foreground">
          {shown.length} of {owners.length}
        </span>
      </div>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              {header("Owner", "name")}
              {header("Balance", "balance", "text-right")}
              <TableHead>Status</TableHead>
              <TableHead>Units</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              {header("Last message", "lastMessage")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((o) => (
              <TableRow key={o.id} className="cursor-pointer" onClick={() => router.push(`/owners/${o.id}`)}>
                <TableCell className="font-medium">
                  <a href={`/owners/${o.id}`} onClick={(e) => e.preventDefault()}>
                    {o.name}
                  </a>
                </TableCell>
                <TableCell className={`text-right tabular-nums ${o.balanceCents <= 0 ? "text-muted-foreground" : ""}`}>
                  {formatEuro(o.balanceCents)}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex max-w-xs flex-wrap gap-1">
                    {o.statuses.map((s) => (
                      <StatusBadge key={s} status={s} />
                    ))}
                    {!o.emailUsable && <StatusBadge status="No usable email" />}
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal text-sm">
                  <div>{o.units.join(", ")}</div>
                  <div className="text-xs text-muted-foreground">{o.developments.join(", ")}</div>
                </TableCell>
                <TableCell className={o.emailUsable ? "" : "text-muted-foreground"}>{o.email ?? "—"}</TableCell>
                <TableCell>{o.phone ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{o.lastMessageAt ? formatDateTime(o.lastMessageAt) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

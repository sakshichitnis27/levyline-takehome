"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

export function ClockForm({ dayMinutes, frozen }: { dayMinutes: number | null; frozen: boolean }) {
  const router = useRouter();
  const [when, setWhen] = useState("");
  const [minutes, setMinutes] = useState(dayMinutes ? String(dayMinutes) : "");

  async function change(body: Record<string, unknown>, message: string) {
    try {
      await api("/api/settings/clock", { body });
      toast.success(message);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="clock-now">Set “now” (Irish time is shown everywhere; enter UTC or with an offset)</Label>
        <div className="flex flex-wrap gap-2">
          <Input id="clock-now" className="w-72" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="2026-12-01T09:00:00Z" />
          <Button variant="outline" onClick={() => change({ now: when }, "Clock moved")} disabled={!when}>
            Jump there
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["+1 hour", 60],
              ["+12 hours", 720],
              ["+1 day", 1440],
              ["+3 days", 4320],
              ["+1 week", 10080],
            ] as const
          ).map(([label, mins]) => (
            <Button key={label} size="sm" variant="secondary" onClick={() => change({ advanceMinutes: mins }, `Skipped ahead ${label.slice(1)}`)}>
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="clock-day">Length of a day, in real minutes (blank or 0 = normal speed)</Label>
        <div className="flex gap-2">
          <Input id="clock-day" className="w-40" type="number" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <Button variant="outline" onClick={() => change({ dayMinutes: Number(minutes) || 0 }, "Clock speed changed")}>
            Set speed
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => change({ frozen: !frozen }, frozen ? "Clock running" : "Clock frozen")}>
          {frozen ? "Unfreeze the clock" : "Freeze the clock"}
        </Button>
        <Button variant="ghost" onClick={() => change({ reset: true }, "Back to real time")}>
          Back to real time
        </Button>
      </div>
    </div>
  );
}

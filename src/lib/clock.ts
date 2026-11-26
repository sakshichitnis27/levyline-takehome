// The app's clock. Everything time-based (contact hours, one email a day,
// Waits, instalment dates, missed instalments) reads `now()` from here, never
// `new Date()`, so time can be fixed or sped up in development:
//
//   LEVYLINE_NOW=2026-12-01T09:00:00Z   start the clock at this instant
//   LEVYLINE_DAY_MINUTES=5              one day lasts 5 real minutes
//   LEVYLINE_FREEZE=1                   stop the clock at LEVYLINE_NOW
//
// The same settings can be changed live on /settings. They're stored in the
// database, so the clock carries on (rather than jumping back) after a restart.

import { pool } from "@/lib/db";
import type { Db } from "@/lib/sql";

export type ClockSettings = {
  anchorReal: number; // real ms at which virtual time was anchorVirtual
  anchorVirtual: number;
  speed: number; // virtual ms per real ms
  frozen: boolean;
  source: "real" | "env" | "staff";
  envSignature?: string;
};

export const REAL_CLOCK: ClockSettings = { anchorReal: 0, anchorVirtual: 0, speed: 1, frozen: false, source: "real" };

export function virtualTime(settings: ClockSettings, realMs: number): number {
  if (settings.source === "real") return realMs;
  if (settings.frozen) return settings.anchorVirtual;
  return settings.anchorVirtual + (realMs - settings.anchorReal) * settings.speed;
}

/** Real milliseconds until virtual time reaches `target` (for scheduling). */
export function realDelayUntil(settings: ClockSettings, target: number, realMs: number): number {
  const remaining = target - virtualTime(settings, realMs);
  if (settings.source === "real") return remaining;
  if (settings.frozen) return Infinity;
  return remaining / settings.speed;
}

function envSettings(realMs: number): ClockSettings | null {
  const start = process.env.LEVYLINE_NOW?.trim();
  const dayMinutes = Number(process.env.LEVYLINE_DAY_MINUTES || 0);
  const frozen = process.env.LEVYLINE_FREEZE === "1";
  if (!start && !dayMinutes) return null;
  const signature = JSON.stringify([start, dayMinutes, frozen]);
  const anchorVirtual = start ? Date.parse(start) : realMs;
  if (Number.isNaN(anchorVirtual)) throw new Error(`LEVYLINE_NOW is not a date: ${start}`);
  return {
    anchorReal: realMs,
    anchorVirtual,
    speed: dayMinutes > 0 ? 1440 / dayMinutes : 1,
    frozen,
    source: "env",
    envSignature: signature,
  };
}

let cache: { at: number; settings: ClockSettings } | null = null;

export async function getClockSettings(db: Db = pool): Promise<ClockSettings> {
  const realMs = Date.now();
  if (cache && realMs - cache.at < 1000) return cache.settings;
  const { rows } = await db.query<{ value: ClockSettings }>("select value from app_settings where key = 'clock'");
  let settings: ClockSettings | null = rows[0]?.value ?? null;
  const fromEnv = envSettings(realMs);
  // Env settings apply the first time they're seen (or when they change);
  // after that the stored anchor keeps time running across restarts.
  if (fromEnv && (!settings || (settings.source === "env" && settings.envSignature !== fromEnv.envSignature))) {
    settings = fromEnv;
    await saveClock(settings, db);
  }
  if (!fromEnv && settings?.source === "env") {
    settings = null;
    await db.query("delete from app_settings where key = 'clock'");
  }
  settings ??= REAL_CLOCK;
  cache = { at: realMs, settings };
  return settings;
}

async function saveClock(settings: ClockSettings, db: Db) {
  await db.query(
    `insert into app_settings (key, value) values ('clock', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(settings)],
  );
  cache = null;
}

export async function now(db: Db = pool): Promise<Date> {
  return new Date(virtualTime(await getClockSettings(db), Date.now()));
}

/** Staff controls on /settings. Re-anchors at the current virtual instant so nothing jumps unexpectedly. */
export async function setClock(change: {
  now?: string;
  advanceMinutes?: number;
  dayMinutes?: number;
  frozen?: boolean;
  reset?: boolean;
}) {
  if (change.reset) {
    await pool.query("delete from app_settings where key = 'clock'");
    cache = null;
    return;
  }
  const current = await getClockSettings();
  const realMs = Date.now();
  const anchorVirtual =
    (change.now ? Date.parse(change.now) : virtualTime(current, realMs)) + (change.advanceMinutes ?? 0) * 60_000;
  if (Number.isNaN(anchorVirtual)) throw new Error("Not a valid date and time");
  const speed =
    change.dayMinutes !== undefined ? (change.dayMinutes > 0 ? 1440 / change.dayMinutes : 1) : current.speed;
  await saveClock(
    {
      anchorReal: realMs,
      anchorVirtual,
      speed,
      frozen: change.frozen ?? current.frozen,
      source: "staff",
    },
    pool,
  );
}

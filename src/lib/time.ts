// Irish-time helpers. Pure: every function takes the instant it reasons about.

const TZ = "Europe/Dublin";

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function irishParts(at: Date) {
  const p = Object.fromEntries(partsFormat.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS[p.weekday],
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** The Irish calendar date (YYYY-MM-DD) at an instant. */
export function irishDate(at: Date): string {
  return irishParts(at).date;
}

/** Rule 9: Monday to Saturday, 08:00 to 20:00 Irish time. */
export function inContactHours(at: Date): boolean {
  const { weekday, hour } = irishParts(at);
  return weekday >= 1 && weekday <= 6 && hour >= 8 && hour < 20;
}

/** The first instant at or after `at` that is inside contact hours (to the minute). */
export function nextContactWindow(at: Date): Date {
  if (inContactHours(at)) return at;
  // Walk forward in 15-minute steps, then back up to the exact minute.
  let t = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 4 * 24 * 8; i++) {
    t = new Date(t.getTime() + 15 * 60_000);
    if (inContactHours(t)) {
      let back = t;
      while (inContactHours(new Date(back.getTime() - 60_000)) && back.getTime() - 60_000 > at.getTime()) {
        back = new Date(back.getTime() - 60_000);
      }
      return back;
    }
  }
  return t;
}

/** Start of the next Irish calendar day after `at`. */
export function startOfNextIrishDay(at: Date): Date {
  const today = irishDate(at);
  let t = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  while (irishDate(t) === today) t = new Date(t.getTime() + 15 * 60_000);
  while (irishDate(new Date(t.getTime() - 60_000)) !== today) t = new Date(t.getTime() - 60_000);
  return t;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a) for YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-IE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(at: Date | string): string {
  return new Date(at).toLocaleString("en-IE", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

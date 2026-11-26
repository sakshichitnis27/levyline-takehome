// Pure parsing and tidying for imported values. Nothing here guesses: a value
// is either read with certainty, read with a recorded tidy-up, or rejected
// with a reason (rule 1).

export type Parsed<T> =
  | { ok: true; value: T; tidied?: string }
  | { ok: false; reason: string };

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function toCsv(rows: string[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(","),
    )
    .join("\n");
}

// ---------- Text ----------

export function collapse(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function titleCaseWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/^(Mac|Mc)(\p{L})/u, (_, p: string, ch: string) => p + ch.toUpperCase());
}

export function tidyName(raw: string): Parsed<string> {
  const value = collapse(raw);
  if (!value) return { ok: false, reason: "name is blank" };
  const letters = value.replace(/[^\p{L}]/gu, "");
  const shouting = letters === letters.toUpperCase() || letters === letters.toLowerCase();
  const tidiedValue = shouting
    ? value.split(" ").map(titleCaseWord).join(" ")
    : value;
  return tidiedValue !== raw
    ? { ok: true, value: tidiedValue, tidied: `name "${raw}" → "${tidiedValue}"` }
    : { ok: true, value };
}

/** Identity key for a person's name: case, spacing and Unicode form only. */
export function nameKey(name: string): string {
  return collapse(name).toLowerCase();
}

/** Looser key for suggesting possible duplicates (accents and punctuation ignored). */
export function looseNameKey(name: string): string {
  return collapse(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Key for matching place names that differ only by spacing or case ("Harbourview" vs "Harbour View"). */
export function placeKey(name: string): string {
  return collapse(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// ---------- Email and phone ----------

// Same pattern as src/lib/email.ts, so "usable" here means sendEmail accepts it.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailValue = { address: string; usable: boolean; tidied?: string; problem?: string };

export function tidyEmail(raw: string): EmailValue | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const address = trimmed.toLowerCase();
  const tidied = address !== raw ? `email "${raw}" → "${address}"` : undefined;
  if (!EMAIL_PATTERN.test(address)) {
    return { address, usable: false, tidied, problem: `"${trimmed}" is not a valid email address` };
  }
  return { address, usable: true, tidied };
}

export type PhoneValue = { number: string; usable: boolean; tidied?: string; problem?: string };

export function tidyPhone(raw: string): PhoneValue | null {
  const trimmed = collapse(raw);
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, "");
  let national: string | null = null;
  if (/^\+353\d+$/.test(digits)) national = digits.slice(4);
  else if (/^00353\d+$/.test(digits)) national = digits.slice(5);
  else if (/^0\d+$/.test(digits)) national = digits.slice(1);

  if (national !== null) {
    // Irish numbers have 8 or 9 national digits (mobiles: 8X + 7 digits).
    if (national.length < 8 || national.length > 9) {
      return { number: trimmed, usable: false, problem: `phone "${trimmed}" looks incomplete` };
    }
    const formatted = /^8\d{8}$/.test(national)
      ? `+353 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`
      : `+353 ${national}`;
    return {
      number: formatted,
      usable: true,
      tidied: formatted !== trimmed ? `phone "${trimmed}" → "${formatted}"` : undefined,
    };
  }
  if (/^\+\d{8,15}$/.test(digits)) return { number: trimmed, usable: true };
  return { number: trimmed, usable: false, problem: `phone "${trimmed}" is not a recognisable number` };
}

// ---------- Money ----------

/** Parses an amount to integer cents. Comma-decimal formats are ambiguous in this file and rejected. */
export function parseAmount(raw: string, label = "amount"): Parsed<number> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: `${label} is blank` };
  let s = trimmed.replace(/\s/g, "");
  let stripped = false;
  if (/€|EUR/i.test(s)) {
    s = s.replace(/€|EUR/gi, "");
    stripped = true;
  }
  const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/^-|^\(|\)$/g, "");

  let normalised: string | null = null;
  let tidy: string | undefined = stripped ? "removed currency symbol" : undefined;
  if (/^\d+(\.\d{1,2})?$/.test(s)) {
    normalised = s;
  } else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) {
    normalised = s.replace(/,/g, "");
    tidy = [tidy, "removed thousands separators"].filter(Boolean).join(", ");
  } else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
    return {
      ok: false,
      reason: `${label} "${trimmed}" uses a comma as the decimal point, unlike the rest of the file; it could mean more than one number, so it was not read`,
    };
  } else {
    return { ok: false, reason: `${label} "${trimmed}" is not a number` };
  }
  const [whole, frac = ""] = normalised.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: `${label} "${trimmed}" is too large` };
  const value = negative ? -cents : cents;
  return tidy
    ? { ok: true, value, tidied: `${label} "${trimmed}" → ${formatCents(value)} (${tidy})` }
    : { ok: true, value };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------- Dates ----------

export type DateOrder = "dmy" | "mdy";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/** Looks at every numeric date in a column and says which order the file must be using, if it can tell. */
export function detectDateOrder(values: string[]): {
  order: DateOrder | null;
  evidence: string | null;
  conflicting: boolean;
} {
  let dmy: string | null = null;
  let mdy: string | null = null;
  for (const raw of values) {
    const m = raw.trim().match(NUMERIC_DATE);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy ??= raw.trim();
    if (b > 12 && a <= 12) mdy ??= raw.trim();
  }
  if (dmy && mdy) return { order: null, evidence: `${dmy} and ${mdy}`, conflicting: true };
  if (dmy) return { order: "dmy", evidence: dmy, conflicting: false };
  if (mdy) return { order: "mdy", evidence: mdy, conflicting: false };
  return { order: null, evidence: null, conflicting: false };
}

/**
 * Parses a date. Numeric dates whose day and month could be swapped are only
 * read when staff have confirmed the file's order; otherwise they're rejected.
 */
export function parseDate(raw: string, order: DateOrder | null, label = "due date"): Parsed<string> {
  const s = collapse(raw);
  if (!s) return { ok: false, reason: `${label} is blank` };

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { ok: true, value: iso } : { ok: false, reason: `${label} "${s}" is not a real date` };
  }

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.? (\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    const iso = month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
    return iso
      ? { ok: true, value: iso, tidied: `${label} "${s}" → ${iso}` }
      : { ok: false, reason: `${label} "${s}" is not a real date` };
  }

  m = s.match(NUMERIC_DATE);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (!order) {
      if (a <= 12 && b <= 12 && a !== b) {
        return {
          ok: false,
          reason: `${label} "${s}" could be ${a} ${monthName(b)} or ${b} ${monthName(a)}; choose the file's date format to read it`,
        };
      }
      const iso = a > 12 ? isoDate(y, b, a) : b > 12 ? isoDate(y, a, b) : isoDate(y, a, a);
      return iso ? { ok: true, value: iso } : { ok: false, reason: `${label} "${s}" is not a real date` };
    }
    const iso = order === "dmy" ? isoDate(y, b, a) : isoDate(y, a, b);
    return iso
      ? { ok: true, value: iso }
      : { ok: false, reason: `${label} "${s}" is not a real date (read as ${order === "dmy" ? "DD/MM/YYYY" : "MM/DD/YYYY"})` };
  }
  return { ok: false, reason: `${label} "${s}" is not a date` };
}

function monthName(m: number): string {
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m] ?? `month ${m}`;
}

// ---------- Notes ----------

export type NoteFlags = {
  doNotContact: boolean;
  disputed: boolean;
  deceased: boolean;
  sold: boolean;
};

/** Reads the free-text Notes column for things that must change what staff can do (rule 4). */
export function readNoteFlags(note: string): NoteFlags {
  const n = note.toLowerCase();
  return {
    doNotContact: /\bdnc\b|do not contact|don't contact|solicitor acting/.test(n),
    disputed: /disput/.test(n),
    deceased: /deceased|\bdied\b|passed away/.test(n),
    sold: /\bsold\b/.test(n),
  };
}

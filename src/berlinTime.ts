// The CRM's owner lives in Europe/Berlin, and the web app turns "due 2026-07-15
// 09:00" into an instant in the browser's (Berlin) time. This server runs in
// UTC (Vercel), where `new Date("2026-07-15T09:00:00")` would mean 09:00 UTC —
// 11:00 in Berlin. Every wall-clock date or time a tool takes goes through
// here instead, DST-correct via Intl.

export const TIME_ZONE = "Europe/Berlin";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Berlin's offset from UTC at the instant `ms`, in milliseconds. */
function offsetAt(ms: number): number {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant (ISO, UTC) at which the Berlin wall clock shows `date` `time`.
 * A time skipped by the spring change (02:30 on the last Sunday of March)
 * lands one hour later; an ambiguous autumn time takes the second (winter)
 * occurrence.
 */
export function berlinToIso(date: string, time = "00:00"): string {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date "${date}" — expected YYYY-MM-DD`);
  if (!TIME_RE.test(time)) throw new Error(`Invalid time "${time}" — expected HH:MM`);
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  if (new Date(wall).getUTCDate() !== d) throw new Error(`Invalid date "${date}"`);
  // Two passes: the offset at the first guess can differ from the one at the
  // result when a DST change lies between them.
  const first = wall - offsetAt(wall);
  const second = wall - offsetAt(first);
  return new Date(offsetAt(second) === wall - second ? second : Math.max(first, second)).toISOString();
}

/** The day after `date` (YYYY-MM-DD), for half-open "until the end of that day" ranges. */
export function nextDay(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date "${date}" — expected YYYY-MM-DD`);
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

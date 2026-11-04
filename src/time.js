// Time-zone math without a library. Workers run in UTC; every "today",
// "this week" and shift time here is in the school's local zone.

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `timeZone`. */
export function localParts(date, timeZone) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday],
  };
}

const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of an instant in `timeZone`. */
export function localDate(date, timeZone) {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight of an instant in `timeZone`. */
export function localMinutes(date, timeZone) {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

// How far `timeZone` is ahead of UTC at `date`, in ms.
function offsetMs(date, timeZone) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads `dateStr` `hhmm`.
 * Two passes, so it stays right on the days the clocks change.
 */
export function zonedTime(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = (hhmm || "00:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** `dateStr` moved by `days` calendar days ("YYYY-MM-DD" in, out). */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Local date of the first day of the week containing `date`. */
export function weekStartDate(date, timeZone, weekStartsOn) {
  const today = localDate(date, timeZone);
  const back = (localParts(date, timeZone).weekday - weekStartsOn + 7) % 7;
  return addDays(today, -back);
}

/** Minutes of [start, end) that fall inside [from, to). */
export function overlapMinutes(start, end, from, to) {
  const a = Math.max(start.getTime(), from.getTime());
  const b = Math.min(end.getTime(), to.getTime());
  return b > a ? Math.floor((b - a) / 60000) : 0;
}

/** "7:56 AM" in `timeZone`. */
export function clockLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** "HH:MM" (24-hour) -> minutes since midnight. */
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

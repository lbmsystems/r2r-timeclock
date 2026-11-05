// The owners' dashboard: what needs attention today, hours for payroll,
// the week's schedule, and fixing punches. Every function here runs only
// after access.js has confirmed the caller is an owner.

import {
  STAFF, SCHEDULE, PUNCHES, TIME_ZONE, WEEK_STARTS_ON, LATE_GRACE_MINUTES, AIRTABLE_URL,
} from "./config.js";
import { formulaString } from "./airtable.js";
import { shiftTypeRows, sortedShiftTypes } from "./kiosk.js";
import {
  localDate, localMinutes, zonedTime, addDays, weekStartDate, clockLabel,
} from "./time.js";

export class AdminError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Still clocked in this long after their last scheduled shift ends -> alert.
export const OVER_SHIFT_GRACE_MINUTES = 30;
// Clocked in with no shift scheduled today -> alert after this long.
export const UNSCHEDULED_MAX_HOURS = 10;
// Longest shift a manual fix may create.
export const MAX_SHIFT_HOURS = 16;
// Longest range the hours view will total.
export const MAX_RANGE_DAYS = 62;

const iso = (d) => d.toISOString();
const linkIds = (v) => (Array.isArray(v) ? v : []);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => DATE_RE.test(String(d)) && addDays(String(d), 0) === d;
const dateLabel = (d, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
const parseTime = (f) => `DATETIME_PARSE(${formulaString(iso(f))})`;

function punchView(p, now) {
  const inAt = p.fields[PUNCHES.clockIn] ? new Date(p.fields[PUNCHES.clockIn]) : null;
  const outAt = p.fields[PUNCHES.clockOut] ? new Date(p.fields[PUNCHES.clockOut]) : null;
  const date = inAt ? localDate(inAt, TIME_ZONE) : null;
  const minutes = inAt && outAt ? Math.max(0, Math.round((outAt - inAt) / 60000)) : 0;
  return {
    id: p.id,
    staffId: linkIds(p.fields[PUNCHES.staff])[0] ?? null,
    date,
    clockIn: inAt ? iso(inAt) : null,
    clockOut: outAt ? iso(outAt) : null,
    inLabel: inAt ? clockLabel(inAt, TIME_ZONE) : "",
    outLabel: outAt ? clockLabel(outAt, TIME_ZONE) : "",
    // For <input type="datetime-local">, in the school's time zone.
    inLocal: inAt ? `${date}T${hhmm(inAt)}` : "",
    outLocal: outAt ? `${localDate(outAt, TIME_ZONE)}T${hhmm(outAt)}` : "",
    minutes,
    runningMinutes: inAt && !outAt ? Math.max(0, Math.round((now - inAt) / 60000)) : 0,
    open: Boolean(inAt && !outAt),
    source: p.fields[PUNCHES.source]?.name ?? p.fields[PUNCHES.source] ?? "",
    editedBy: p.fields[PUNCHES.editedBy] ?? "",
    editReason: p.fields[PUNCHES.editReason] ?? "",
    note: p.fields[PUNCHES.note] ?? "",
  };
}

function hhmm(date) {
  const m = localMinutes(date, TIME_ZONE);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function staffIndex(staffRows) {
  const nameOf = new Map();
  const active = [];
  for (const r of staffRows) {
    const name = String(r.fields[STAFF.name] ?? "").trim();
    if (!name) continue;
    nameOf.set(r.id, name);
    if (r.fields[STAFF.active]) active.push({ id: r.id, name });
  }
  active.sort((a, b) => a.name.localeCompare(b.name));
  return { nameOf, active };
}

// --------------------------------------------------------------------- today

export async function getOverview(at, now = new Date()) {
  const today = localDate(now, TIME_ZONE);
  const dayStart = zonedTime(today, "00:00", TIME_ZONE);
  const nowMin = localMinutes(now, TIME_ZONE);

  const [staffRows, punchRows, shiftTypes, schedule] = await Promise.all([
    at.list(STAFF.table),
    at.list(PUNCHES.table, {
      filterByFormula: `OR({${PUNCHES.clockOut}} = BLANK(), IS_AFTER({${PUNCHES.clockIn}}, ${parseTime(new Date(dayStart - 60000))}))`,
    }),
    shiftTypeRows(at),
    at.list(SCHEDULE.table, {
      filterByFormula: `DATETIME_FORMAT({${SCHEDULE.date}}, 'YYYY-MM-DD') = ${formulaString(today)}`,
    }),
  ]);
  const { nameOf, active } = staffIndex(staffRows);
  const types = sortedShiftTypes(shiftTypes);
  const punches = punchRows.map((p) => punchView(p, now)).filter((p) => p.clockIn && p.staffId);

  // Who is scheduled on which of today's shifts.
  const shiftsOf = new Map();
  for (const t of types) {
    for (const row of schedule) {
      if (!linkIds(row.fields[SCHEDULE.shift]).includes(t.id)) continue;
      for (const id of linkIds(row.fields[SCHEDULE.staff])) {
        if (!shiftsOf.has(id)) shiftsOf.set(id, []);
        if (!shiftsOf.get(id).includes(t)) shiftsOf.get(id).push(t);
      }
    }
  }

  const todays = punches.filter((p) => p.date === today);
  const byStaffToday = new Map();
  for (const p of todays) {
    if (!byStaffToday.has(p.staffId)) byStaffToday.set(p.staffId, []);
    byStaffToday.get(p.staffId).push(p);
  }

  const attention = [];
  for (const p of punches.filter((x) => x.open)) {
    const name = nameOf.get(p.staffId) ?? "Unknown";
    if (p.date < today) {
      attention.push({
        type: "missing_out",
        name,
        punch: p,
        dayLabel: dateLabel(p.date),
        text: `${name} never clocked out on ${dateLabel(p.date, { weekday: "long", month: "short", day: "numeric" })}`,
      });
      continue;
    }
    const mine = shiftsOf.get(p.staffId) ?? [];
    if (mine.length) {
      const lastEnd = Math.max(...mine.map((t) => t.end));
      if (nowMin >= lastEnd + OVER_SHIFT_GRACE_MINUTES) {
        const endLabel = clockLabel(zonedTime(today, mine.find((t) => t.end === lastEnd).endLabel, TIME_ZONE), TIME_ZONE);
        attention.push({ type: "over_shift", name, punch: p, text: `${name} is still clocked in. Their shift ended at ${endLabel}` });
      }
    } else if (p.runningMinutes >= UNSCHEDULED_MAX_HOURS * 60) {
      attention.push({ type: "over_shift", name, punch: p, text: `${name} has been clocked in for over ${UNSCHEDULED_MAX_HOURS} hours` });
    }
  }
  for (const [staffId, mine] of shiftsOf) {
    if (!nameOf.has(staffId) || byStaffToday.has(staffId)) continue;
    const late = mine.find((t) => nowMin >= t.start + LATE_GRACE_MINUTES && nowMin < t.end);
    const missed = mine.filter((t) => nowMin >= t.end);
    const name = nameOf.get(staffId);
    if (late) {
      const startLabel = clockLabel(zonedTime(today, late.startLabel, TIME_ZONE), TIME_ZONE);
      attention.push({ type: "not_in", name, staffId, text: `${name} hasn't clocked in. ${late.name} started at ${startLabel}` });
    } else if (missed.length && !mine.some((t) => nowMin < t.end)) {
      attention.push({ type: "no_show", name, staffId, text: `${name} was scheduled (${missed.map((t) => t.name).join(", ")}) but never clocked in` });
    }
  }

  const ids = new Set([...shiftsOf.keys(), ...byStaffToday.keys()]);
  const people = [...ids]
    .filter((id) => nameOf.has(id))
    .map((id) => {
      const mine = (byStaffToday.get(id) ?? []).sort((a, b) => a.clockIn.localeCompare(b.clockIn));
      const shifts = (shiftsOf.get(id) ?? []).map((t) => t.name);
      const openNow = mine.find((p) => p.open);
      const minutes = mine.reduce((s, p) => s + (p.open ? p.runningMinutes : p.minutes), 0);
      let status = "off";
      if (openNow) status = "in";
      else if (mine.length) status = "done";
      else if (attention.some((a) => a.staffId === id && a.type === "not_in")) status = "late";
      else if (attention.some((a) => a.staffId === id && a.type === "no_show")) status = "no_show";
      else if (shifts.length) status = "scheduled";
      return {
        staffId: id,
        name: nameOf.get(id),
        shifts,
        status,
        firstIn: mine[0]?.inLabel ?? "",
        lastOut: openNow ? "" : (mine.at(-1)?.outLabel ?? ""),
        minutes,
        punches: mine,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    now: iso(now),
    today,
    todayLabel: dateLabel(today, { weekday: "long", month: "long", day: "numeric" }),
    timeLabel: clockLabel(now, TIME_ZONE),
    stats: {
      inNow: people.filter((p) => p.status === "in").length,
      minutesToday: people.reduce((s, p) => s + p.minutes, 0),
      needsAttention: attention.length,
    },
    attention,
    people,
    staff: active,
    airtableUrl: AIRTABLE_URL,
  };
}

// --------------------------------------------------------------------- hours

function checkRange(from, to) {
  if (!isDate(from) || !isDate(to)) throw new AdminError(400, "bad_date");
  if (from > to) throw new AdminError(400, "bad_range");
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (++days > MAX_RANGE_DAYS) throw new AdminError(400, "range_too_long", { maxDays: MAX_RANGE_DAYS });
  return days;
}

export async function getHours(at, from, to, now = new Date()) {
  checkRange(from, to);
  const start = zonedTime(from, "00:00", TIME_ZONE);
  const end = zonedTime(addDays(to, 1), "00:00", TIME_ZONE);
  const [staffRows, punchRows] = await Promise.all([
    at.list(STAFF.table),
    at.list(PUNCHES.table, {
      filterByFormula: `AND(IS_AFTER({${PUNCHES.clockIn}}, ${parseTime(new Date(start - 1000))}), IS_BEFORE({${PUNCHES.clockIn}}, ${parseTime(end)}))`,
    }),
  ]);
  const { nameOf, active } = staffIndex(staffRows);
  const byStaff = new Map(active.map((s) => [s.id, []]));
  for (const p of punchRows.map((r) => punchView(r, now))) {
    if (!p.staffId || !p.clockIn) continue;
    if (!byStaff.has(p.staffId)) byStaff.set(p.staffId, []);
    byStaff.get(p.staffId).push(p);
  }
  const today = localDate(now, TIME_ZONE);
  const people = [...byStaff]
    .filter(([id]) => nameOf.has(id))
    .map(([id, list]) => {
      list.sort((a, b) => a.clockIn.localeCompare(b.clockIn));
      const minutes = list.reduce((s, p) => s + p.minutes, 0);
      const missing = list.filter((p) => p.open && p.date < today).length;
      const inProgress = list.filter((p) => p.open && p.date === today).length;
      const edited = list.filter((p) => p.source === "Manual fix").length;
      return {
        staffId: id,
        name: nameOf.get(id),
        minutes,
        shifts: list.length,
        days: new Set(list.map((p) => p.date)).size,
        missing,
        inProgress,
        edited,
        punches: list,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    from,
    to,
    label: `${dateLabel(from, { month: "short", day: "numeric" })} – ${dateLabel(to, { month: "short", day: "numeric", year: "numeric" })}`,
    people,
    totals: {
      minutes: people.reduce((s, p) => s + p.minutes, 0),
      shifts: people.reduce((s, p) => s + p.shifts, 0),
      missing: people.reduce((s, p) => s + p.missing, 0),
    },
  };
}

// Spreadsheet apps run cells starting with = + - @ as formulas; prefix those
// so a note can never become a formula in the payroll file.
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const hours2 = (min) => (Math.round((min / 60) * 100) / 100).toFixed(2);

export function hoursCsv(result) {
  const lines = [["Name", "Date", "Clock in", "Clock out", "Hours", "Source", "Edited by", "Edit reason", "Note"]];
  for (const person of result.people) {
    for (const p of person.punches) {
      lines.push([
        person.name, p.date, p.inLabel, p.open ? "(missing)" : p.outLabel, p.open ? "" : hours2(p.minutes),
        p.source, p.editedBy, p.editReason, p.note,
      ]);
    }
  }
  lines.push([]);
  lines.push(["Totals", `${result.from} to ${result.to}`]);
  lines.push(["Name", "Hours", "Shifts", "Missing clock-outs"]);
  for (const person of result.people) lines.push([person.name, hours2(person.minutes), person.shifts, person.missing]);
  return lines.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------- week

export async function getWeek(at, start, now = new Date()) {
  const today = localDate(now, TIME_ZONE);
  if (!start) start = weekStartDate(now, TIME_ZONE, WEEK_STARTS_ON);
  if (!isDate(start)) throw new AdminError(400, "bad_date");
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const rangeStart = zonedTime(start, "00:00", TIME_ZONE);
  const rangeEnd = zonedTime(addDays(start, 7), "00:00", TIME_ZONE);
  const nowMin = localMinutes(now, TIME_ZONE);

  const [staffRows, shiftTypes, schedule, punchRows] = await Promise.all([
    at.list(STAFF.table),
    shiftTypeRows(at),
    at.list(SCHEDULE.table, {
      filterByFormula: `AND(IS_AFTER({${SCHEDULE.date}}, DATETIME_PARSE(${formulaString(addDays(start, -1))})), IS_BEFORE({${SCHEDULE.date}}, DATETIME_PARSE(${formulaString(addDays(start, 7))})))`,
    }),
    at.list(PUNCHES.table, {
      filterByFormula: `AND(IS_AFTER({${PUNCHES.clockIn}}, ${parseTime(new Date(rangeStart - 1000))}), IS_BEFORE({${PUNCHES.clockIn}}, ${parseTime(rangeEnd)}))`,
    }),
  ]);
  const { nameOf } = staffIndex(staffRows);
  const worked = new Map(); // "date|staffId" -> "in" | "worked"
  for (const p of punchRows.map((r) => punchView(r, now))) {
    if (!p.staffId || !p.date) continue;
    const key = `${p.date}|${p.staffId}`;
    if (p.open && p.date === today) worked.set(key, "in");
    else if (!worked.has(key)) worked.set(key, "worked");
  }

  const shifts = sortedShiftTypes(shiftTypes).map((t) => ({
    name: t.name,
    startLabel: clockLabel(zonedTime(start, t.startLabel, TIME_ZONE), TIME_ZONE),
    endLabel: clockLabel(zonedTime(start, t.endLabel, TIME_ZONE), TIME_ZONE),
    cells: days.map((d) => {
      const ids = new Set();
      for (const row of schedule) {
        const rowDate = String(row.fields[SCHEDULE.date] ?? "").slice(0, 10);
        if (rowDate !== d || !linkIds(row.fields[SCHEDULE.shift]).includes(t.id)) continue;
        for (const id of linkIds(row.fields[SCHEDULE.staff])) ids.add(id);
      }
      const started = d < today || (d === today && nowMin >= t.start + LATE_GRACE_MINUTES);
      return {
        date: d,
        people: [...ids]
          .filter((id) => nameOf.has(id))
          .map((id) => {
            const w = worked.get(`${d}|${id}`);
            const status = w ?? (started ? "missed" : "scheduled");
            return { name: nameOf.get(id), status };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
  }));

  return {
    start,
    label: `${dateLabel(start, { month: "short", day: "numeric" })} – ${dateLabel(days[6], { month: "short", day: "numeric", year: "numeric" })}`,
    prev: addDays(start, -7),
    next: addDays(start, 7),
    days: days.map((d) => ({ date: d, dow: dateLabel(d, { weekday: "short" }), day: dateLabel(d, { month: "short", day: "numeric" }), isToday: d === today })),
    shifts,
    airtableUrl: AIRTABLE_URL,
  };
}

// ------------------------------------------------------------------- fixing

const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
function parseLocal(value, field) {
  const m = LOCAL_RE.exec(String(value ?? ""));
  if (!m || !isDate(m[1])) throw new AdminError(400, "bad_time", { field });
  return zonedTime(m[1], m[2], TIME_ZONE);
}

function checkTimes(inAt, outAt, now) {
  if (inAt > new Date(now.getTime() + 5 * 60000)) throw new AdminError(400, "in_future");
  if (outAt) {
    if (outAt <= inAt) throw new AdminError(400, "out_before_in");
    if (outAt > new Date(now.getTime() + 5 * 60000)) throw new AdminError(400, "out_future");
    if (outAt - inAt > MAX_SHIFT_HOURS * 3600000) throw new AdminError(400, "too_long", { maxHours: MAX_SHIFT_HOURS });
  }
}

function checkReason(reason) {
  const r = String(reason ?? "").trim();
  if (r.length < 2) throw new AdminError(400, "reason_required");
  return r.slice(0, 500);
}

/** Change a punch's times. Always records who changed it and why. */
export async function updatePunch(at, email, id, body, now = new Date()) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(id))) throw new AdminError(400, "bad_id");
  const [rec] = await at.list(PUNCHES.table, { filterByFormula: `RECORD_ID() = ${formulaString(id)}` });
  if (!rec) throw new AdminError(404, "not_found");
  const reason = checkReason(body?.reason);
  const inAt = body?.clockIn ? parseLocal(body.clockIn, "clockIn") : new Date(rec.fields[PUNCHES.clockIn]);
  const outAt = body?.clockOut ? parseLocal(body.clockOut, "clockOut") : (rec.fields[PUNCHES.clockOut] ? new Date(rec.fields[PUNCHES.clockOut]) : null);
  checkTimes(inAt, outAt, now);
  const stamp = `${localDate(now, TIME_ZONE)} ${clockLabel(now, TIME_ZONE)}`;
  const prev = rec.fields[PUNCHES.editReason];
  const updated = await at.update(PUNCHES.table, id, {
    [PUNCHES.clockIn]: iso(inAt),
    [PUNCHES.clockOut]: outAt ? iso(outAt) : null,
    [PUNCHES.source]: "Manual fix",
    [PUNCHES.editedBy]: email,
    [PUNCHES.editReason]: prev ? `${prev}\n${stamp}: ${reason}` : `${stamp}: ${reason}`,
  });
  return punchView(updated, now);
}

/** Add a punch the kiosk never saw (a forgotten clock-in, say). */
export async function createPunch(at, email, body, now = new Date()) {
  const staffId = String(body?.staffId ?? "");
  if (!/^rec[A-Za-z0-9]{14}$/.test(staffId)) throw new AdminError(400, "bad_staff");
  const [person] = await at.list(STAFF.table, { filterByFormula: `RECORD_ID() = ${formulaString(staffId)}` });
  if (!person) throw new AdminError(404, "unknown_staff");
  const reason = checkReason(body?.reason);
  const inAt = parseLocal(body?.clockIn, "clockIn");
  const outAt = body?.clockOut ? parseLocal(body.clockOut, "clockOut") : null;
  checkTimes(inAt, outAt, now);
  const stamp = `${localDate(now, TIME_ZONE)} ${clockLabel(now, TIME_ZONE)}`;
  const fields = {
    [PUNCHES.staff]: [staffId],
    [PUNCHES.clockIn]: iso(inAt),
    [PUNCHES.source]: "Manual fix",
    [PUNCHES.editedBy]: email,
    [PUNCHES.editReason]: `${stamp}: ${reason}`,
  };
  if (outAt) fields[PUNCHES.clockOut] = iso(outAt);
  return punchView(await at.create(PUNCHES.table, fields), now);
}

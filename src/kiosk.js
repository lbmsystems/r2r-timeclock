// What the front-door iPad asks for: who is clocked in, today's schedule,
// and clocking someone in or out.

import {
  STAFF, SHIFT_TYPES, SCHEDULE, PUNCHES, ABSENCES,
  TIME_ZONE, WEEK_STARTS_ON, LATE_GRACE_MINUTES,
  MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES, MAX_OFFLINE_AGE_HOURS,
} from "./config.js";
import { formulaString } from "./airtable.js";
import { hashPin, isValidPin, pinMatches } from "./pin.js";
import {
  localDate, localMinutes, zonedTime, weekStartDate, clockLabel, hhmmToMinutes, addDays,
} from "./time.js";

export class KioskError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const iso = (d) => d.toISOString();
const linkIds = (v) => (Array.isArray(v) ? v : []);
const after = (field, date) =>
  `IS_AFTER({${field}}, DATETIME_PARSE(${formulaString(iso(date))}))`;

// ---------------------------------------------------------------- staff codes

/**
 * Hash any code typed into "New PIN" and clear the cell, so a plain code sits
 * in Airtable for at most one kiosk refresh. Returns the records, updated.
 */
async function absorbNewPins(at, env, staffRecords) {
  const out = [];
  for (const r of staffRecords) {
    const typed = String(r.fields[STAFF.newPin] ?? "").trim();
    if (!typed) { out.push(r); continue; }
    if (!isValidPin(typed)) { out.push(r); continue; } // left for a person to fix
    const fields = {
      [STAFF.pinHash]: await hashPin(env.PIN_PEPPER, r.id, typed),
      [STAFF.newPin]: "",
      [STAFF.failedAttempts]: 0,
      [STAFF.lockedUntil]: null,
    };
    out.push(await at.update(STAFF.table, r.id, fields));
  }
  return out;
}

// ---------------------------------------------------------------------- state

const isOpen = (p) => !p.fields[PUNCHES.clockOut];

// Shift times change rarely, so each Worker instance keeps them for a few
// minutes. That is one Airtable call fewer on every kiosk refresh, which
// matters: Airtable allows only 5 calls per second.
const SHIFT_TYPES_TTL_MS = 5 * 60 * 1000;
let shiftTypesCache = null;
export async function shiftTypeRows(at) {
  if (shiftTypesCache && Date.now() - shiftTypesCache.at < SHIFT_TYPES_TTL_MS) return shiftTypesCache.rows;
  const rows = await at.list(SHIFT_TYPES.table);
  shiftTypesCache = { at: Date.now(), rows };
  return rows;
}
export function resetCaches() { shiftTypesCache = null; }

/**
 * Where the kiosk and dashboard load someone's photo from, or null.
 * Airtable's own attachment links expire after a few hours, so pages never
 * see them: /api/photo/<staff id> fetches the image through the Worker. The
 * ?v= part is the attachment's id, so a browser keeps its copy until the
 * photo is replaced.
 */
export function photoPath(staffRecord) {
  const att = Array.isArray(staffRecord?.fields?.[STAFF.photo]) ? staffRecord.fields[STAFF.photo][0] : null;
  return att?.id ? `/api/photo/${staffRecord.id}?v=${encodeURIComponent(att.id)}` : null;
}

/** The image behind photoPath(), for /api/photo. */
export async function staffPhoto(at, staffId, fetchImpl = fetch) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(staffId))) throw new KioskError(400, "bad_staff");
  const [person] = await at.list(STAFF.table, { filterByFormula: `RECORD_ID() = ${formulaString(staffId)}` });
  const att = person && Array.isArray(person.fields[STAFF.photo]) ? person.fields[STAFF.photo][0] : null;
  if (!person || !person.fields[STAFF.active] || !att) throw new KioskError(404, "no_photo");
  // The large thumbnail (about 512px) is plenty for an avatar and far smaller
  // than a phone photo.
  const src = att.thumbnails?.large?.url || att.url;
  let res;
  try {
    res = await fetchImpl(src);
  } catch {
    throw new KioskError(502, "photo_unavailable");
  }
  if (!res.ok) throw new KioskError(502, "photo_unavailable");
  const type = res.headers.get("Content-Type") || att.type || "image/jpeg";
  if (!type.startsWith("image/")) throw new KioskError(502, "photo_unavailable");
  return { body: res.body, type, version: att.id };
}

/** Absences recorded for one day. */
export function absencesOn(at, date) {
  return at.list(ABSENCES.table, {
    filterByFormula: `DATETIME_FORMAT({${ABSENCES.date}}, 'YYYY-MM-DD') = ${formulaString(date)}`,
  });
}

/** staff id -> the shift ids they are marked absent from. */
export function outByStaff(absenceRows) {
  const out = new Map();
  for (const a of absenceRows) {
    for (const staffId of linkIds(a.fields[ABSENCES.staff])) {
      if (!out.has(staffId)) out.set(staffId, new Set());
      for (const shiftId of linkIds(a.fields[ABSENCES.shifts])) out.get(staffId).add(shiftId);
    }
  }
  return out;
}

function openToday(punches, now) {
  const today = localDate(now, TIME_ZONE);
  const open = punches.filter(isOpen);
  // A punch still open from an EARLIER day is a forgotten clock-out. It is
  // left for Tay or the owner to fix, and the person is treated as clocked
  // out, so tapping their name starts a fresh shift instead of closing
  // yesterday's at today's time (which would add a day's worth of hours).
  return open.filter((p) => {
    const t = p.fields[PUNCHES.clockIn];
    return t && localDate(new Date(t), TIME_ZONE) === today;
  });
}

export async function getState(at, env, now = new Date()) {
  const today = localDate(now, TIME_ZONE);
  const dayStart = zonedTime(today, "00:00", TIME_ZONE);

  // One punches query covers both "still open" and "started today".
  const [staffRaw, punches, shiftTypes, schedule, absences] = await Promise.all([
    at.list(STAFF.table),
    at.list(PUNCHES.table, {
      filterByFormula: `OR({${PUNCHES.clockOut}} = BLANK(), ${after(PUNCHES.clockIn, new Date(dayStart - 60000))})`,
    }),
    shiftTypeRows(at),
    at.list(SCHEDULE.table, {
      filterByFormula: `DATETIME_FORMAT({${SCHEDULE.date}}, 'YYYY-MM-DD') = ${formulaString(today)}`,
    }),
    absencesOn(at, today),
  ]);
  const open = openToday(punches, now);
  const todays = punches.filter((p) => p.fields[PUNCHES.clockIn] && new Date(p.fields[PUNCHES.clockIn]) >= dayStart);
  const staffRecords = await absorbNewPins(at, env, staffRaw);

  const inSince = new Map();
  for (const p of open) {
    for (const id of linkIds(p.fields[PUNCHES.staff])) inSince.set(id, new Date(p.fields[PUNCHES.clockIn]));
  }
  const workedToday = new Set();
  for (const p of todays) for (const id of linkIds(p.fields[PUNCHES.staff])) workedToday.add(id);

  const active = staffRecords
    .filter((r) => r.fields[STAFF.active] && r.fields[STAFF.name])
    .sort((a, b) => String(a.fields[STAFF.name]).localeCompare(String(b.fields[STAFF.name])));
  const nameOf = new Map(staffRecords.map((r) => [r.id, String(r.fields[STAFF.name] ?? "")]));

  const staff = active.map((r) => {
    const since = inSince.get(r.id);
    return {
      id: r.id,
      name: r.fields[STAFF.name],
      hasPin: Boolean(r.fields[STAFF.pinHash]),
      photo: photoPath(r),
      clockedInAt: since ? iso(since) : null,
      clockedInLabel: since ? clockLabel(since, TIME_ZONE) : null,
    };
  });

  const shifts = buildShifts(shiftTypes, schedule, nameOf, today, {
    nowMin: localMinutes(now, TIME_ZONE),
    inSince,
    workedToday,
  }, "future", outByStaff(absences));

  return { now: iso(now), timeZone: TIME_ZONE, today, staff, shifts };
}

// ---------------------------------------------------------------------- punch

function minutesOf(punch, until) {
  const a = punch.fields[PUNCHES.clockIn];
  if (!a) return 0;
  const b = punch.fields[PUNCHES.clockOut] ?? until;
  return Math.max(0, Math.floor((new Date(b) - new Date(a)) / 60000));
}

export async function punch(at, env, body, now = new Date()) {
  const { staffId, pin, requestId } = body ?? {};
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(staffId))) throw new KioskError(400, "bad_staff");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(requestId))) throw new KioskError(400, "bad_request_id");
  if (!isValidPin(pin)) throw new KioskError(400, "bad_pin");

  // When it happened. Normally now; for a punch the iPad saved while
  // offline, the iPad's own time, within limits.
  let when = now;
  let offlineNote = "";
  if (body.at !== undefined) {
    const t = new Date(body.at);
    if (Number.isNaN(t.getTime())) throw new KioskError(400, "bad_time");
    if (t - now > 2 * 60000) throw new KioskError(400, "bad_time");
    if (now - t > MAX_OFFLINE_AGE_HOURS * 3600000) throw new KioskError(422, "too_old");
    if (now - t > 60000) {
      when = t;
      offlineNote = `Saved on the kiosk while offline; sent ${clockLabel(now, TIME_ZONE)} ${localDate(now, TIME_ZONE)}.`;
    }
  }

  // A double tap, or a retry of a request that did land, returns the first
  // result instead of punching twice.
  // One query: a punch this request already made (a double tap or a
  // retry), plus every open punch.
  const candidates = await at.list(PUNCHES.table, {
    filterByFormula: `OR({${PUNCHES.requestId}} = ${formulaString(requestId)}, {${PUNCHES.clockOut}} = BLANK())`,
  });
  const seen = candidates.filter((p) => p.fields[PUNCHES.requestId] === requestId);

  const [staffRec] = await at.list(STAFF.table, {
    filterByFormula: `RECORD_ID() = ${formulaString(staffId)}`,
  });
  if (!staffRec || !staffRec.fields[STAFF.active]) throw new KioskError(404, "unknown_staff");
  const [person] = await absorbNewPins(at, env, [staffRec]);
  const name = person.fields[STAFF.name];

  const lockedUntil = person.fields[STAFF.lockedUntil];
  if (lockedUntil && new Date(lockedUntil) > now) {
    throw new KioskError(423, "locked", { until: lockedUntil, untilLabel: clockLabel(new Date(lockedUntil), TIME_ZONE) });
  }
  if (!person.fields[STAFF.pinHash]) throw new KioskError(409, "no_pin", { name });

  if (!(await pinMatches(env.PIN_PEPPER, person.id, pin, person.fields[STAFF.pinHash]))) {
    const failed = Number(person.fields[STAFF.failedAttempts] ?? 0) + 1;
    if (failed >= MAX_FAILED_ATTEMPTS) {
      const until = new Date(now.getTime() + LOCKOUT_MINUTES * 60000);
      await at.update(STAFF.table, person.id, { [STAFF.failedAttempts]: 0, [STAFF.lockedUntil]: iso(until) });
      throw new KioskError(423, "locked", { until: iso(until), untilLabel: clockLabel(until, TIME_ZONE) });
    }
    await at.update(STAFF.table, person.id, { [STAFF.failedAttempts]: failed });
    throw new KioskError(401, "wrong_pin", { attemptsLeft: MAX_FAILED_ATTEMPTS - failed });
  }
  if (person.fields[STAFF.failedAttempts] || lockedUntil) {
    await at.update(STAFF.table, person.id, { [STAFF.failedAttempts]: 0, [STAFF.lockedUntil]: null });
  }

  let action;
  let record;
  const mine = seen.find((p) => linkIds(p.fields[PUNCHES.staff]).includes(person.id));
  if (mine) {
    record = mine;
    action = mine.fields[PUNCHES.clockOut] ? "out" : "in";
  } else {
    const mineOpen = openToday(candidates, when)
      .filter((p) => linkIds(p.fields[PUNCHES.staff]).includes(person.id))
      .filter((p) => new Date(p.fields[PUNCHES.clockIn]) <= when)
      .sort((a, b) => new Date(b.fields[PUNCHES.clockIn]) - new Date(a.fields[PUNCHES.clockIn]));

    if (mineOpen.length) {
      const fields = { [PUNCHES.clockOut]: iso(when), [PUNCHES.requestId]: requestId };
      if (offlineNote) {
        const prev = mineOpen[0].fields[PUNCHES.note];
        fields[PUNCHES.note] = prev ? `${prev}\n${offlineNote}` : offlineNote;
      }
      record = await at.update(PUNCHES.table, mineOpen[0].id, fields);
      action = "out";
    } else {
      const fields = {
        [PUNCHES.staff]: [person.id],
        [PUNCHES.clockIn]: iso(when),
        [PUNCHES.source]: "Kiosk",
        [PUNCHES.requestId]: requestId,
      };
      if (offlineNote) fields[PUNCHES.note] = offlineNote;
      record = await at.create(PUNCHES.table, fields);
      action = "in";
    }
  }

  const result = {
    action,
    name,
    at: record.fields[action === "out" ? PUNCHES.clockOut : PUNCHES.clockIn],
  };
  result.atLabel = clockLabel(new Date(result.at), TIME_ZONE);

  if (action === "out") {
    const today = localDate(now, TIME_ZONE);
    const weekStart = zonedTime(weekStartDate(now, TIME_ZONE, WEEK_STARTS_ON), "00:00", TIME_ZONE);
    const dayStart = zonedTime(today, "00:00", TIME_ZONE);
    const recent = (await at.list(PUNCHES.table, {
      filterByFormula: after(PUNCHES.clockIn, new Date(weekStart - 60000)),
    })).filter((p) => linkIds(p.fields[PUNCHES.staff]).includes(person.id));
    const byId = new Map(recent.map((p) => [p.id, p]));
    byId.set(record.id, record); // the read can lag the write
    const all = [...byId.values()];
    result.shiftMinutes = minutesOf(record, now);
    result.shiftStartLabel = clockLabel(new Date(record.fields[PUNCHES.clockIn]), TIME_ZONE);
    result.todayMinutes = all
      .filter((p) => new Date(p.fields[PUNCHES.clockIn]) >= dayStart)
      .reduce((s, p) => s + minutesOf(p, now), 0);
    result.weekMinutes = all.reduce((s, p) => s + minutesOf(p, now), 0);
  }
  return result;
}

// ------------------------------------------------------------------- shifts

export function sortedShiftTypes(rows) {
  return rows
    .map((t) => ({
      id: t.id,
      name: t.fields[SHIFT_TYPES.name] ?? "Shift",
      start: hhmmToMinutes(t.fields[SHIFT_TYPES.start]),
      end: hhmmToMinutes(t.fields[SHIFT_TYPES.end]),
      startLabel: t.fields[SHIFT_TYPES.start] ?? "",
      endLabel: t.fields[SHIFT_TYPES.end] ?? "",
      order: t.fields[SHIFT_TYPES.order] ?? 99,
    }))
    .filter((t) => t.start !== null && t.end !== null)
    .sort((a, b) => a.order - b.order || a.start - b.start);
}

/**
 * The shifts on `date`, earliest first, each with who is scheduled.
 * With `today` (attendance for the current day) each shift also gets a phase
 * (done / now / next / later) and each person a status (in / done / missing /
 * scheduled). Without it, another day: phase "past" or "future", and everyone
 * is just "scheduled". The kiosk sits in a public spot, so who did or didn't
 * clock in on other days stays in the owners' dashboard.
 */
function buildShifts(shiftTypeRows, scheduleRows, nameOf, date, today, otherDayPhase = "future", out = new Map()) {
  let nextMarked = false;
  return sortedShiftTypes(shiftTypeRows).map((t) => {
    const ids = new Set();
    for (const row of scheduleRows) {
      if (linkIds(row.fields[SCHEDULE.shift]).includes(t.id)) {
        for (const id of linkIds(row.fields[SCHEDULE.staff])) ids.add(id);
      }
    }

    let phase = otherDayPhase;
    if (today) {
      phase = "later";
      if (today.nowMin >= t.end) phase = "done";
      else if (today.nowMin >= t.start) phase = "now";
      else if (!nextMarked) { phase = "next"; nextMarked = true; }
    }

    const people = [...ids]
      .filter((id) => nameOf.has(id))
      .map((id) => {
        // An owner marked them absent for this shift. The kiosk says only
        // "out"; the reason stays in the dashboard.
        const isOut = out.get(id)?.has(t.id) ?? false;
        let status = isOut ? "out" : "scheduled";
        if (today) {
          if (today.inSince.has(id)) status = "in";
          else if (today.workedToday.has(id)) status = "done";
          else if (!isOut && today.nowMin >= t.start + LATE_GRACE_MINUTES) status = "missing";
        }
        return { id, name: nameOf.get(id), status };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      name: t.name,
      start: t.startLabel,
      end: t.endLabel,
      startLabel: clockLabel(zonedTime(date, t.startLabel, TIME_ZONE), TIME_ZONE),
      endLabel: clockLabel(zonedTime(date, t.endLabel, TIME_ZONE), TIME_ZONE),
      phase,
      people,
    };
  });
}

// How far from today the kiosk may look.
export const SCHEDULE_DAYS_BACK = 14;
export const SCHEDULE_DAYS_AHEAD = 90;

/** Who is scheduled on another day (or today, with live statuses). */
export async function getSchedule(at, env, date, now = new Date()) {
  const today = localDate(now, TIME_ZONE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || addDays(date, 0) !== date) {
    throw new KioskError(400, "bad_date");
  }
  if (date < addDays(today, -SCHEDULE_DAYS_BACK) || date > addDays(today, SCHEDULE_DAYS_AHEAD)) {
    throw new KioskError(400, "date_out_of_range", {
      earliest: addDays(today, -SCHEDULE_DAYS_BACK),
      latest: addDays(today, SCHEDULE_DAYS_AHEAD),
    });
  }
  if (date === today) {
    const state = await getState(at, env, now);
    return { date, today, shifts: state.shifts };
  }
  const [staffRows, shiftTypes, schedule, absences] = await Promise.all([
    at.list(STAFF.table),
    shiftTypeRows(at),
    at.list(SCHEDULE.table, {
      filterByFormula: `DATETIME_FORMAT({${SCHEDULE.date}}, 'YYYY-MM-DD') = ${formulaString(date)}`,
    }),
    absencesOn(at, date),
  ]);
  const nameOf = new Map(
    staffRows.filter((r) => r.fields[STAFF.name]).map((r) => [r.id, String(r.fields[STAFF.name])]),
  );
  return {
    date,
    today,
    shifts: buildShifts(shiftTypes, schedule, nameOf, date, null, date < today ? "past" : "future", outByStaff(absences)),
  };
}

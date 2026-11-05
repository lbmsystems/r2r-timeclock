import test from "node:test";
import assert from "node:assert/strict";
import { handleAdmin } from "../src/worker.js";
import { STAFF, SHIFT_TYPES, SCHEDULE, PUNCHES, ABSENCES, SCHEDULE_CHANGES } from "../src/config.js";
import { resetCaches } from "../src/kiosk.js";
import { resetAccessCache } from "../src/access.js";
import { fakeAirtable } from "./fake-airtable.js";

const TEAM = "r2r.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ORIGIN = "https://clock.example";
const ids = {
  asha: "recAsha0000000000", daynely: "recDaynely0000000", ileana: "recIleana00000000",
  jimmy: "recJimmy000000000", selma: "recSelma000000000",
};
// Wednesday Nov 4, 2026, Eastern (UTC-5).
const et = (hhmm, day = "2026-11-04") => new Date(`${day}T${hhmm}:00-05:00`);

// ---- a real RSA key pair, standing in for Cloudflare Access
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1" };
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
async function token(claims = {}, { kid = "k1", key = keyPair.privateKey } = {}) {
  const now = Math.floor(et("15:30").getTime() / 1000);
  const head = b64url(Buffer.from(JSON.stringify({ alg: "RS256", kid })));
  const body = b64url(Buffer.from(JSON.stringify({
    aud: [AUD], iss: `https://${TEAM}`, email: "Tay@RootToRise.example", exp: now + 3600, iat: now, ...claims,
  })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

function setup({ env: extraEnv = {}, absences = [] } = {}) {
  resetCaches();
  resetAccessCache();
  const fake = fakeAirtable({
    [STAFF.table]: Object.entries(ids).map(([k, id]) => ({ id, fields: { [STAFF.name]: k[0].toUpperCase() + k.slice(1), [STAFF.active]: true } })),
    [SHIFT_TYPES.table]: [
      { id: "recMorning0000000", fields: { [SHIFT_TYPES.name]: "Morning", [SHIFT_TYPES.start]: "07:00", [SHIFT_TYPES.end]: "13:00", [SHIFT_TYPES.order]: 1 } },
      { id: "recMidday00000000", fields: { [SHIFT_TYPES.name]: "Midday", [SHIFT_TYPES.start]: "13:00", [SHIFT_TYPES.end]: "16:00", [SHIFT_TYPES.order]: 2 } },
      { id: "recAfternoon00000", fields: { [SHIFT_TYPES.name]: "Afternoon", [SHIFT_TYPES.start]: "16:00", [SHIFT_TYPES.end]: "18:00", [SHIFT_TYPES.order]: 3 } },
    ],
    [SCHEDULE.table]: [
      { fields: { [SCHEDULE.date]: "2026-11-04", [SCHEDULE.shift]: ["recMorning0000000"], [SCHEDULE.staff]: [ids.selma, ids.jimmy, ids.ileana] } },
      { fields: { [SCHEDULE.date]: "2026-11-04", [SCHEDULE.shift]: ["recMidday00000000"], [SCHEDULE.staff]: [ids.daynely] } },
      { fields: { [SCHEDULE.date]: "2026-11-03", [SCHEDULE.shift]: ["recMorning0000000"], [SCHEDULE.staff]: [ids.asha, ids.jimmy] } },
      { fields: { [SCHEDULE.date]: "2026-11-05", [SCHEDULE.shift]: ["recMorning0000000"], [SCHEDULE.staff]: [ids.asha] } },
    ],
    [ABSENCES.table]: absences,
    [SCHEDULE_CHANGES.table]: [],
    [PUNCHES.table]: [
      // Asha: clocked in yesterday, never out.
      { id: "recPunchAsha00001", fields: { [PUNCHES.staff]: [ids.asha], [PUNCHES.clockIn]: et("07:01", "2026-11-03").toISOString(), [PUNCHES.source]: "Kiosk" } },
      // Selma: in since 7:02, her Morning shift ended at 1 PM.
      { id: "recPunchSelma0001", fields: { [PUNCHES.staff]: [ids.selma], [PUNCHES.clockIn]: et("07:02").toISOString(), [PUNCHES.source]: "Kiosk" } },
      // Ileana: worked 6:58 to 1:04 today.
      { id: "recPunchIleana001", fields: { [PUNCHES.staff]: [ids.ileana], [PUNCHES.clockIn]: et("06:58").toISOString(), [PUNCHES.clockOut]: et("13:04").toISOString(), [PUNCHES.source]: "Kiosk", [PUNCHES.note]: "=SUM(1,2)" } },
      // Jimmy: worked Monday.
      { id: "recPunchJimmy0001", fields: { [PUNCHES.staff]: [ids.jimmy], [PUNCHES.clockIn]: et("07:00", "2026-11-02").toISOString(), [PUNCHES.clockOut]: et("12:30", "2026-11-02").toISOString(), [PUNCHES.source]: "Kiosk" } },
    ],
  });
  const env = { AIRTABLE_TOKEN: "t", PIN_PEPPER: "p", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extraEnv };
  let certCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) { certCalls++; return Response.json({ keys: [jwk] }); }
    return fake.fetchImpl(url, init);
  };
  let clock = et("15:30");
  const call = async (method, path, { body, jwt, headers = {} } = {}) => {
    const h = { "Content-Type": "application/json", ...headers };
    if (jwt !== null) h["Cf-Access-Jwt-Assertion"] = jwt ?? (await token());
    const req = new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const res = await handleAdmin(req, env, { fetchImpl, now: () => clock });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { fake, call, setClock: (d) => { clock = d; }, certCalls: () => certCalls };
}

// ------------------------------------------------------------------ access

test("the dashboard stays locked until Cloudflare Access is set up", async () => {
  const { call } = setup({ env: { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } });
  const r = await call("GET", "/admin/api/overview");
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "dashboard_not_protected");
});

test("requests without a valid Access token are refused", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/admin/api/overview", { jwt: null })).status, 401);
  assert.equal((await call("GET", "/admin/api/overview", { jwt: "not.a.token" })).status, 401);

  const otherKeys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"],
  );
  assert.equal((await call("GET", "/admin/api/overview", { jwt: await token({}, { key: otherKeys.privateKey }) })).status, 401, "forged signature");
  assert.equal((await call("GET", "/admin/api/overview", { jwt: await token({ aud: ["someone-elses-app"] }) })).status, 401, "wrong app");
  assert.equal((await call("GET", "/admin/api/overview", { jwt: await token({ exp: 1 }) })).status, 401, "expired");
  assert.equal((await call("GET", "/admin/api/overview", { jwt: await token({ iss: "https://evil.cloudflareaccess.com" }) })).status, 401, "wrong team");
});

test("ADMIN_EMAILS narrows who gets in", async () => {
  const { call } = setup({ env: { ADMIN_EMAILS: "owner@roottorise.example" } });
  const r = await call("GET", "/admin/api/overview");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "not_an_owner");
  const ok = await call("GET", "/admin/api/overview", { jwt: await token({ email: "OWNER@roottorise.example" }) });
  assert.equal(ok.status, 200);
});

test("a valid token gets in, and Access's keys are fetched once", async () => {
  const { call, certCalls } = setup();
  const r = await call("GET", "/admin/api/overview");
  assert.equal(r.status, 200);
  assert.equal(r.body.me, "tay@roottorise.example");
  await call("GET", "/admin/api/overview");
  assert.equal(certCalls(), 1);
});

// ------------------------------------------------------------------- today

test("today: alerts for a forgotten clock-out, an overrun shift, a late arrival and a no-show", async () => {
  const { call } = setup();
  const r = await call("GET", "/admin/api/overview");
  const byType = Object.fromEntries(r.body.attention.map((a) => [a.type + ":" + a.name, a]));
  assert.ok(byType["missing_out:Asha"], "Asha never clocked out yesterday");
  assert.equal(byType["missing_out:Asha"].punch.inLocal, "2026-11-03T07:01");
  assert.ok(byType["over_shift:Selma"], "Selma still in, 2.5 hours after her shift");
  assert.ok(byType["not_in:Daynely"], "Daynely's Midday started at 1 PM");
  assert.ok(byType["no_show:Jimmy"], "Jimmy's Morning came and went");
  assert.equal(r.body.attention.length, 4);

  const status = Object.fromEntries(r.body.people.map((p) => [p.name, p.status]));
  assert.deepEqual(status, { Daynely: "late", Ileana: "done", Jimmy: "no_show", Selma: "in" });
  const ileana = r.body.people.find((p) => p.name === "Ileana");
  assert.equal(ileana.minutes, 366);
  assert.equal(ileana.firstIn, "6:58 AM");
  assert.equal(r.body.stats.inNow, 1);
  assert.equal(r.body.stats.needsAttention, 4);
  assert.equal(r.body.staff.length, 5);
});

test("before a shift starts, nobody is flagged for it", async () => {
  const { call, setClock } = setup();
  setClock(et("06:30"));
  const r = await call("GET", "/admin/api/overview");
  assert.deepEqual(r.body.attention.map((a) => a.type), ["missing_out"]);
});

// ------------------------------------------------------------------- hours

test("hours total each person over a range, and flag a missing clock-out", async () => {
  const { call } = setup();
  const r = await call("GET", "/admin/api/hours?from=2026-11-01&to=2026-11-07");
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.people.map((p) => [p.name, p]));
  assert.equal(by.Jimmy.minutes, 330);
  assert.equal(by.Ileana.minutes, 366);
  assert.equal(by.Asha.minutes, 0);
  assert.equal(by.Asha.missing, 1);
  assert.equal(by.Selma.inProgress, 1);
  assert.equal(by.Daynely.shifts, 0);
  assert.equal(r.body.totals.minutes, 696);

  const narrow = await call("GET", "/admin/api/hours?from=2026-11-04&to=2026-11-04");
  assert.equal(narrow.body.totals.shifts, 2, "only Wednesday's punches");
});

test("hours refuse bad or huge ranges", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/admin/api/hours?from=2026-11-07&to=2026-11-01")).body.error, "bad_range");
  assert.equal((await call("GET", "/admin/api/hours?from=nope&to=2026-11-01")).body.error, "bad_date");
  assert.equal((await call("GET", "/admin/api/hours?from=2026-01-01&to=2026-11-01")).body.error, "range_too_long");
});

test("the payroll CSV has a row per shift, totals, and can't smuggle in a formula", async () => {
  const { call } = setup();
  const r = await call("GET", "/admin/api/hours.csv?from=2026-11-01&to=2026-11-07");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Disposition"), /r2r-hours-2026-11-01-to-2026-11-07\.csv/);
  assert.match(r.text, /^Name,Date,Clock in,Clock out,Hours,/);
  assert.match(r.text, /Ileana,2026-11-04,6:58 AM,1:04 PM,6\.10,Kiosk,,,"'=SUM\(1,2\)"/);
  assert.match(r.text, /Asha,2026-11-03,7:01 AM,\(missing\),/);
  assert.match(r.text, /\r\nJimmy,5\.50,1,0,0\r\n/);
});

// -------------------------------------------------------------------- week

test("the week grid shows who worked, who missed, and who is coming", async () => {
  const { call } = setup();
  const r = await call("GET", "/admin/api/week?start=2026-11-01");
  assert.equal(r.status, 200);
  assert.equal(r.body.days.length, 7);
  assert.equal(r.body.days[3].isToday, true);
  const morning = r.body.shifts[0];
  const cell = (d) => Object.fromEntries(morning.cells.find((c) => c.date === d).people.map((p) => [p.name, p.status]));
  assert.deepEqual(cell("2026-11-03"), { Asha: "worked", Jimmy: "missed" });
  assert.deepEqual(cell("2026-11-04"), { Ileana: "worked", Jimmy: "missed", Selma: "in" });
  assert.deepEqual(cell("2026-11-05"), { Asha: "scheduled" });
  assert.equal(r.body.next, "2026-11-08");
});

// ----------------------------------------------------------------- fixing

test("fixing a forgotten clock-out records who did it and why", async () => {
  const { fake, call } = setup();
  const r = await call("PATCH", "/admin/api/punches/recPunchAsha00001", {
    body: { clockOut: "2026-11-03T13:05", reason: "Forgot to clock out; left after Morning" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outLabel, "1:05 PM");
  assert.equal(r.body.minutes, 364);
  const row = fake.db[PUNCHES.table].find((p) => p.id === "recPunchAsha00001").fields;
  assert.equal(row[PUNCHES.source], "Manual fix");
  assert.equal(row[PUNCHES.editedBy], "tay@roottorise.example");
  assert.match(row[PUNCHES.editReason], /^2026-11-04 3:30 PM: Forgot to clock out/);

  const after = await call("GET", "/admin/api/overview");
  assert.ok(!after.body.attention.some((a) => a.type === "missing_out"));
});

test("fixes are checked before they are saved", async () => {
  const { call } = setup();
  const patch = (body) => call("PATCH", "/admin/api/punches/recPunchAsha00001", { body });
  assert.equal((await patch({ clockOut: "2026-11-03T13:05" })).body.error, "reason_required");
  assert.equal((await patch({ clockOut: "2026-11-03T06:00", reason: "x y" })).body.error, "out_before_in");
  assert.equal((await patch({ clockOut: "2026-11-04T09:00", reason: "x y" })).body.error, "too_long");
  assert.equal((await patch({ clockOut: "2026-11-05T09:00", reason: "x y" })).body.error, "out_future");
  assert.equal((await patch({ clockOut: "tomorrow", reason: "x y" })).body.error, "bad_time");
  assert.equal((await call("PATCH", "/admin/api/punches/recNope0000000000", { body: { reason: "x y" } })).status, 404);
  const evil = await call("PATCH", "/admin/api/punches/recPunchAsha00001", {
    body: { clockOut: "2026-11-03T13:05", reason: "x y" }, headers: { Origin: "https://evil.example" },
  });
  assert.equal(evil.status, 403);
});

test("adding a missed punch", async () => {
  const { fake, call } = setup();
  const r = await call("POST", "/admin/api/punches", {
    body: { staffId: ids.daynely, clockIn: "2026-11-04T13:00", clockOut: "2026-11-04T15:00", reason: "iPad was down" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.minutes, 120);
  assert.equal(fake.db[PUNCHES.table].length, 5);
  const bad = await call("POST", "/admin/api/punches", { body: { staffId: "recNope0000000000", clockIn: "2026-11-04T13:00", reason: "x y" } });
  assert.equal(bad.status, 404);
});

// ------------------------------------------------------------------ order

test("today lists people by shift: Morning, then Midday, then Afternoon", async () => {
  const { call } = setup();
  const r = await call("GET", "/admin/api/overview");
  // Morning: Ileana, Jimmy, Selma (by name); Midday: Daynely.
  assert.deepEqual(r.body.people.map((p) => p.name), ["Ileana", "Jimmy", "Selma", "Daynely"]);
});

// --------------------------------------------------------------- absences

const sick = (extra = {}) => ({ staffId: ids.daynely, date: "2026-11-04", reason: "Called out sick", note: "Texted Tay at 6am", ...extra });

test("marking someone absent clears their alert and records why, who and when", async () => {
  const { fake, call } = setup();
  const before = await call("GET", "/admin/api/overview");
  const alert = before.body.attention.find((a) => a.type === "not_in");
  assert.equal(alert.name, "Daynely");
  assert.deepEqual(alert.shiftIds, ["recMidday00000000"]);

  const r = await call("POST", "/admin/api/absences", { body: sick({ shiftIds: alert.shiftIds }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.shiftNames, ["Midday"]);
  const row = fake.db[ABSENCES.table][0].fields;
  assert.equal(row[ABSENCES.summary], "Daynely · Wed, Nov 4 · Midday");
  assert.equal(row[ABSENCES.reason], "Called out sick");
  assert.equal(row[ABSENCES.recordedBy], "tay@roottorise.example");
  assert.equal(row[ABSENCES.recordedAt], et("15:30").toISOString());
  assert.equal(fake.db[SCHEDULE.table].length, 4, "the schedule itself is untouched");

  const after = await call("GET", "/admin/api/overview");
  assert.ok(!after.body.attention.some((a) => a.name === "Daynely"));
  const daynely = after.body.people.find((p) => p.name === "Daynely");
  assert.equal(daynely.status, "absent");
  assert.equal(daynely.absences[0].reason, "Called out sick");

});

test("a no-show can be marked for every missed shift at once, and undone", async () => {
  const { call } = setup();
  const r = await call("POST", "/admin/api/absences", { body: { staffId: ids.jimmy, date: "2026-11-04", reason: "No-show" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.shiftNames, ["Morning"]);
  let o = await call("GET", "/admin/api/overview");
  assert.ok(!o.body.attention.some((a) => a.type === "no_show"));

  const undo = await call("DELETE", `/admin/api/absences/${r.body.id}`);
  assert.equal(undo.status, 200);
  o = await call("GET", "/admin/api/overview");
  assert.ok(o.body.attention.some((a) => a.type === "no_show" && a.name === "Jimmy"));
});

test("absences are checked before they are saved", async () => {
  const { call } = setup();
  const post = (body) => call("POST", "/admin/api/absences", { body });
  assert.equal((await post(sick({ reason: "Felt like it" }))).body.error, "bad_reason");
  assert.equal((await post(sick({ staffId: ids.asha }))).body.error, "not_scheduled", "Asha isn't on Wednesday");
  assert.equal((await post(sick({ shiftIds: ["recMorning0000000"] }))).body.error, "not_scheduled", "Daynely isn't on Morning");
  assert.equal((await post(sick({ date: "2027-06-01" }))).body.error, "date_out_of_range");
  assert.equal((await post(sick())).status, 200);
  const again = await post(sick());
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_marked");
  assert.equal((await call("DELETE", "/admin/api/absences/recNope0000000000")).status, 404);
});

test("someone calling out ahead of time can be marked for a future day", async () => {
  const { call } = setup();
  const r = await call("POST", "/admin/api/absences", { body: { staffId: ids.asha, date: "2026-11-05", reason: "Personal / family" } });
  assert.equal(r.status, 200);
  const w = await call("GET", "/admin/api/week?start=2026-11-01");
  const thu = w.body.shifts[0].cells.find((c) => c.date === "2026-11-05").people;
  assert.deepEqual(thu, [{ name: "Asha", status: "absent", reason: "Personal / family" }]);
});

test("absences show in the hours view and the payroll CSV", async () => {
  const { call } = setup();
  await call("POST", "/admin/api/absences", { body: sick() });
  const h = await call("GET", "/admin/api/hours?from=2026-11-01&to=2026-11-07");
  assert.equal(h.body.totals.absences, 1);
  assert.equal(h.body.people.find((p) => p.name === "Daynely").absences[0].reason, "Called out sick");
  const csv = await call("GET", "/admin/api/hours.csv?from=2026-11-01&to=2026-11-07");
  assert.match(csv.text, /\r\nAbsences\r\nName,Date,Shifts,Reason,Note,Recorded by\r\nDaynely,2026-11-04,Midday,Called out sick,Texted Tay at 6am,tay@roottorise\.example\r\n/);
});

// ------------------------------------------------------------ change shift

test("changing someone's shift updates the schedule, logs it, and clears the alert", async () => {
  const { fake, call } = setup();
  // Daynely's Midday started at 1 PM; she's actually doing Afternoon (4 PM).
  const before = await call("GET", "/admin/api/overview");
  assert.ok(before.body.attention.some((a) => a.name === "Daynely" && a.type === "not_in"));
  assert.deepEqual(before.body.shiftTypes.map((t) => t.name), ["Morning", "Midday", "Afternoon"]);

  const r = await call("POST", "/admin/api/shift-changes", {
    body: { staffId: ids.daynely, date: "2026-11-04", fromShiftId: "recMidday00000000", toShiftId: "recAfternoon00000", note: "Swapped her day around" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary, "Daynely · Wed, Nov 4 · Midday → Afternoon");

  const sched = fake.db[SCHEDULE.table].filter((row) => row.fields[SCHEDULE.date] === "2026-11-04");
  const staffOn = (shift) => sched.filter((row) => row.fields[SCHEDULE.shift][0] === shift).flatMap((row) => row.fields[SCHEDULE.staff]);
  assert.deepEqual(staffOn("recMidday00000000"), []);
  assert.deepEqual(staffOn("recAfternoon00000"), [ids.daynely], "a row for Afternoon was added");

  const log = fake.db[SCHEDULE_CHANGES.table][0].fields;
  assert.deepEqual(log[SCHEDULE_CHANGES.fromShift], ["recMidday00000000"]);
  assert.deepEqual(log[SCHEDULE_CHANGES.toShift], ["recAfternoon00000"]);
  assert.equal(log[SCHEDULE_CHANGES.changedBy], "tay@roottorise.example");
  assert.equal(log[SCHEDULE_CHANGES.note], "Swapped her day around");

  const after = await call("GET", "/admin/api/overview");
  assert.ok(!after.body.attention.some((a) => a.name === "Daynely"), "Afternoon hasn't started yet");
  const daynely = after.body.people.find((p) => p.name === "Daynely");
  assert.deepEqual(daynely.shifts, ["Afternoon"]);
  assert.deepEqual(daynely.movedFrom, ["Midday"]);
  assert.equal(daynely.status, "scheduled");
});

test("moving onto a shift that already has people adds to its row", async () => {
  const { fake, call } = setup();
  const r = await call("POST", "/admin/api/shift-changes", {
    body: { staffId: ids.jimmy, date: "2026-11-04", fromShiftId: "recMorning0000000", toShiftId: "recMidday00000000" },
  });
  assert.equal(r.status, 200);
  const midday = fake.db[SCHEDULE.table].find((row) => row.fields[SCHEDULE.date] === "2026-11-04" && row.fields[SCHEDULE.shift][0] === "recMidday00000000");
  assert.deepEqual(midday.fields[SCHEDULE.staff], [ids.daynely, ids.jimmy]);
  assert.equal(fake.db[SCHEDULE.table].length, 4, "no extra row");
});

test("shift changes are checked before anything is saved", async () => {
  const { fake, call } = setup();
  const move = (b) => call("POST", "/admin/api/shift-changes", { body: { staffId: ids.selma, date: "2026-11-04", fromShiftId: "recMorning0000000", toShiftId: "recMidday00000000", ...b } });
  assert.equal((await move({ toShiftId: "recMorning0000000" })).body.error, "same_shift");
  assert.equal((await move({ staffId: ids.asha })).body.error, "not_scheduled", "Asha isn't on Wednesday Morning");
  assert.equal((await move({ toShiftId: "recNope0000000000" })).body.error, "bad_shift");
  assert.equal((await move({ date: "2027-06-01" })).body.error, "date_out_of_range");
  fake.db[SCHEDULE.table][1].fields[SCHEDULE.staff].push(ids.selma); // Selma already on Midday too
  const dup = await move({});
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "already_on_shift");
  assert.equal(fake.db[SCHEDULE_CHANGES.table].length, 0, "nothing logged");
});

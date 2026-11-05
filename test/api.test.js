import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/worker.js";
import { STAFF, SHIFT_TYPES, SCHEDULE, PUNCHES, ABSENCES, SCHEDULE_CHANGES } from "../src/config.js";
import { hashPin } from "../src/pin.js";
import { resetCaches } from "../src/kiosk.js";
import { airtable } from "../src/airtable.js";
import { fakeAirtable } from "./fake-airtable.js";

const env = { AIRTABLE_TOKEN: "test-token", PIN_PEPPER: "test-pepper" };
const SELMA = "recSelma000000000";
const ASHA = "recAsha0000000000";
const ORIGIN = "https://clock.example";

// Wednesday Nov 4, 2026; Eastern is UTC-5.
const at = (hhmm, day = "2026-11-04") => new Date(`${day}T${hhmm}:00-05:00`);

async function setup(extraPunches = [], absences = []) {
  resetCaches();
  const fake = fakeAirtable({
    [STAFF.table]: [
      { id: SELMA, fields: { [STAFF.name]: "Selma", [STAFF.active]: true, [STAFF.newPin]: "1234" } },
      { id: ASHA, fields: { [STAFF.name]: "Asha", [STAFF.active]: true, [STAFF.pinHash]: await hashPin(env.PIN_PEPPER, ASHA, "4321") } },
      { id: "recGone0000000000", fields: { [STAFF.name]: "Former", [STAFF.active]: false } },
    ],
    [SHIFT_TYPES.table]: [
      { id: "recMorning0000000", fields: { [SHIFT_TYPES.name]: "Morning", [SHIFT_TYPES.start]: "07:00", [SHIFT_TYPES.end]: "13:00", [SHIFT_TYPES.order]: 1 } },
      { id: "recMidday00000000", fields: { [SHIFT_TYPES.name]: "Midday", [SHIFT_TYPES.start]: "13:00", [SHIFT_TYPES.end]: "16:00", [SHIFT_TYPES.order]: 2 } },
      { id: "recAfternoon00000", fields: { [SHIFT_TYPES.name]: "Afternoon", [SHIFT_TYPES.start]: "16:00", [SHIFT_TYPES.end]: "18:00", [SHIFT_TYPES.order]: 3 } },
    ],
    [SCHEDULE.table]: [
      { fields: { [SCHEDULE.date]: "2026-11-04", [SCHEDULE.shift]: ["recMorning0000000"], [SCHEDULE.staff]: [SELMA, ASHA] } },
      { fields: { [SCHEDULE.date]: "2026-11-05", [SCHEDULE.shift]: ["recMorning0000000"], [SCHEDULE.staff]: [ASHA] } },
    ],
    [ABSENCES.table]: absences,
    [SCHEDULE_CHANGES.table]: [],
    [PUNCHES.table]: extraPunches,
  });
  let clock = at("08:52");
  const call = async (method, path, body, headers = {}) => {
    const req = new Request(ORIGIN + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await handleApi(req, env, { fetchImpl: fake.fetchImpl, now: () => clock });
    return { status: res.status, body: await res.json() };
  };
  return { fake, call, setClock: (d) => { clock = d; } };
}

let n = 0;
const rid = () => `req-${Date.now()}-${++n}`;

test("state lists active staff and turns a typed New PIN into a hash", async () => {
  const { fake, call } = await setup();
  const r = await call("GET", "/api/state");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.staff.map((s) => s.name), ["Asha", "Selma"]);
  assert.equal(r.body.today, "2026-11-04");

  const selma = fake.db[STAFF.table].find((x) => x.id === SELMA);
  assert.equal(selma.fields[STAFF.newPin], "");
  assert.match(selma.fields[STAFF.pinHash], /^v1:[0-9a-f]{64}$/);
  assert.ok(!selma.fields[STAFF.pinHash].includes("1234"));
});

test("schedule shows who is late once the shift is 15 minutes in", async () => {
  const { call, setClock } = await setup();
  setClock(at("07:10"));
  let s = (await call("GET", "/api/state")).body.shifts;
  assert.equal(s[0].phase, "now");
  assert.deepEqual(s[0].people.map((p) => p.status), ["scheduled", "scheduled"]);
  assert.equal(s[1].phase, "next");

  await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() });
  setClock(at("07:20"));
  s = (await call("GET", "/api/state")).body.shifts;
  assert.deepEqual(s[0].people.map((p) => [p.name, p.status]), [["Asha", "in"], ["Selma", "missing"]]);
  assert.equal(s[0].startLabel, "7:00 AM");
});

test("clock in, then clock out with totals", async () => {
  const { fake, call, setClock } = await setup();
  setClock(at("08:58"));
  let r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, "in");
  assert.equal(r.body.atLabel, "8:58 AM");

  const state = (await call("GET", "/api/state")).body;
  assert.equal(state.staff.find((s) => s.id === ASHA).clockedInLabel, "8:58 AM");

  setClock(at("15:04"));
  r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() });
  assert.equal(r.body.action, "out");
  assert.equal(r.body.shiftMinutes, 366); // 6h 06m
  assert.equal(r.body.todayMinutes, 366);
  assert.equal(r.body.weekMinutes, 366);
  const rows = fake.db[PUNCHES.table];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields[PUNCHES.source], "Kiosk");
});

test("a repeated request does not punch twice", async () => {
  const { fake, call } = await setup();
  const body = { staffId: ASHA, pin: "4321", requestId: rid() };
  const a = await call("POST", "/api/punch", body);
  const b = await call("POST", "/api/punch", body);
  assert.equal(a.body.action, "in");
  assert.equal(b.body.action, "in");
  assert.equal(fake.db[PUNCHES.table].length, 1);
});

test("wrong codes count down, then lock the name", async () => {
  const { fake, call, setClock } = await setup();
  for (let i = 4; i >= 1; i--) {
    const r = await call("POST", "/api/punch", { staffId: ASHA, pin: "0000", requestId: rid() });
    assert.equal(r.status, 401);
    assert.equal(r.body.attemptsLeft, i);
  }
  let r = await call("POST", "/api/punch", { staffId: ASHA, pin: "0000", requestId: rid() });
  assert.equal(r.status, 423);
  // Even the right code is refused while locked...
  r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() });
  assert.equal(r.status, 423);
  // ...and works again afterwards, with the counter reset.
  setClock(at("09:00"));
  r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() });
  assert.equal(r.status, 200);
  const asha = fake.db[STAFF.table].find((x) => x.id === ASHA);
  assert.equal(asha.fields[STAFF.failedAttempts], 0);
  assert.equal(asha.fields[STAFF.lockedUntil], null);
});

test("someone with no code is told to ask for one", async () => {
  const { fake, call } = await setup();
  fake.db[STAFF.table].find((x) => x.id === SELMA).fields[STAFF.newPin] = "";
  const r = await call("POST", "/api/punch", { staffId: SELMA, pin: "1234", requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "no_pin");
});

test("a shift left open yesterday is not closed by today's tap", async () => {
  const { fake, call } = await setup([
    { fields: { [PUNCHES.staff]: [ASHA], [PUNCHES.clockIn]: at("09:00", "2026-11-03").toISOString(), [PUNCHES.source]: "Kiosk" } },
  ]);
  let state = (await call("GET", "/api/state")).body;
  assert.equal(state.staff.find((s) => s.id === ASHA).clockedInAt, null);

  const r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() });
  assert.equal(r.body.action, "in");
  const rows = fake.db[PUNCHES.table];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields[PUNCHES.clockOut], undefined); // still flagged for a person to fix
});

test("offline punches keep the iPad's time, within 12 hours", async () => {
  const { fake, call, setClock } = await setup();
  setClock(at("10:00"));
  let r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid(), at: at("08:55").toISOString() });
  assert.equal(r.body.action, "in");
  assert.equal(r.body.atLabel, "8:55 AM");
  assert.match(fake.db[PUNCHES.table][0].fields[PUNCHES.note], /offline/);

  r = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid(), at: at("08:00", "2026-11-03").toISOString() });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "too_old");
});

test("bad input and other sites are refused", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/api/punch", { staffId: "nope", pin: "4321", requestId: rid() })).status, 400);
  assert.equal((await call("POST", "/api/punch", { staffId: ASHA, pin: "12", requestId: rid() })).status, 400);
  assert.equal((await call("POST", "/api/punch", { staffId: "recGone0000000000", pin: "1111", requestId: rid() })).status, 404);
  const evil = await call("POST", "/api/punch", { staffId: ASHA, pin: "4321", requestId: rid() }, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
});

test("Airtable down or unreachable answers 502, so the kiosk keeps the punch and retries", async () => {
  const req = () => new Request(ORIGIN + "/api/state");
  const down = await handleApi(req(), env, { fetchImpl: async () => new Response("busy", { status: 503 }) });
  assert.equal(down.status, 502);
  const gone = await handleApi(req(), env, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(gone.status, 502);
  assert.equal((await gone.json()).error, "airtable_unavailable");
});

test("a missing secret is named, never shown", async () => {
  const r = await handleApi(new Request(ORIGIN + "/api/state"), { PIN_PEPPER: "x" });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "not_configured", missing: ["AIRTABLE_TOKEN"] });
});

test("schedule for another day lists who is scheduled, without attendance", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/schedule?date=2026-11-05");
  assert.equal(r.status, 200);
  assert.equal(r.body.date, "2026-11-05");
  assert.equal(r.body.today, "2026-11-04");
  const [morning, midday] = r.body.shifts;
  assert.equal(morning.phase, "future");
  assert.deepEqual(morning.people.map((p) => [p.name, p.status]), [["Asha", "scheduled"]]);
  assert.deepEqual(midday.people, []);
  assert.equal(morning.startLabel, "7:00 AM");

  const past = await call("GET", "/api/schedule?date=2026-11-02");
  assert.equal(past.body.shifts[0].phase, "past");
});

test("schedule for today is the live view", async () => {
  const { call, setClock } = await setup();
  setClock(at("07:30"));
  const r = await call("GET", "/api/schedule?date=2026-11-04");
  assert.equal(r.body.shifts[0].phase, "now");
  assert.deepEqual(r.body.shifts[0].people.map((p) => p.status), ["missing", "missing"]);
});

test("schedule refuses bad or far-off dates", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/api/schedule?date=nope")).body.error, "bad_date");
  assert.equal((await call("GET", "/api/schedule?date=2026-02-30")).body.error, "bad_date");
  assert.equal((await call("GET", "/api/schedule")).body.error, "bad_date");
  const far = await call("GET", "/api/schedule?date=2027-06-01");
  assert.equal(far.status, 400);
  assert.equal(far.body.error, "date_out_of_range");
  assert.equal(far.body.latest, "2027-02-02");
});

test("a kiosk refresh stays well under Airtable's 5-per-second limit", async () => {
  const { fake, call } = await setup();
  await call("GET", "/api/state");
  // Reads only: the first refresh also saves Selma's typed New PIN once.
  const reads = fake.calls.filter((c) => c.method === "GET").length;
  assert.ok(reads <= 5, `first refresh made ${reads} Airtable reads`);
  fake.calls.length = 0;
  await call("GET", "/api/state");
  // staff, punches, today's schedule, today's absences; shift times are cached
  assert.equal(fake.calls.length, 4);
});

test("Airtable saying 'too many requests' is retried, not shown as an error", async () => {
  let n = 0;
  const flaky = async () => (++n === 1
    ? new Response("rate limited", { status: 429 })
    : Response.json({ records: [{ id: "rec1", fields: {} }] }));
  const at = airtable("t", { fetchImpl: flaky, retryDelays: [0, 0] });
  const rows = await at.list("tblX");
  assert.equal(rows.length, 1);
  assert.equal(n, 2);

  const always = airtable("t", { fetchImpl: async () => new Response("no", { status: 429 }), retryDelays: [0, 0] });
  await assert.rejects(always.list("tblX"), /Airtable 429/);
});

test("the kiosk shows someone marked absent as out, without the reason", async () => {
  const { call, setClock } = await setup([], [
    { fields: { [ABSENCES.date]: "2026-11-04", [ABSENCES.staff]: [SELMA], [ABSENCES.shifts]: ["recMorning0000000"], [ABSENCES.reason]: "Called out sick" } },
  ]);
  setClock(at("09:00"));
  const r = await call("GET", "/api/state");
  const morning = r.body.shifts[0];
  assert.deepEqual(morning.people.map((p) => [p.name, p.status]), [["Asha", "missing"], ["Selma", "out"]]);
  assert.ok(!JSON.stringify(r.body).includes("sick"));
});

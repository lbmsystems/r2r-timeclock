import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/worker.js";
import { STAFF, SHIFT_TYPES, SCHEDULE, PUNCHES } from "../src/config.js";
import { hashPin } from "../src/pin.js";
import { fakeAirtable } from "./fake-airtable.js";

const env = { AIRTABLE_TOKEN: "test-token", PIN_PEPPER: "test-pepper" };
const SELMA = "recSelma000000000";
const ASHA = "recAsha0000000000";
const ORIGIN = "https://clock.example";

// Wednesday Nov 4, 2026; Eastern is UTC-5.
const at = (hhmm, day = "2026-11-04") => new Date(`${day}T${hhmm}:00-05:00`);

async function setup(extraPunches = []) {
  const fake = fakeAirtable({
    [STAFF.table]: [
      { id: SELMA, fields: { [STAFF.name]: "Selma", [STAFF.active]: true, [STAFF.newPin]: "1234" } },
      { id: ASHA, fields: { [STAFF.name]: "Asha", [STAFF.active]: true, [STAFF.pinHash]: await hashPin(env.PIN_PEPPER, ASHA, "4321") } },
      { id: "recGone0000000000", fields: { [STAFF.name]: "Former", [STAFF.active]: false } },
    ],
    [SHIFT_TYPES.table]: [
      { id: "recMorning000000", fields: { [SHIFT_TYPES.name]: "Morning", [SHIFT_TYPES.start]: "07:00", [SHIFT_TYPES.end]: "13:00", [SHIFT_TYPES.order]: 1 } },
      { id: "recMidday0000000", fields: { [SHIFT_TYPES.name]: "Midday", [SHIFT_TYPES.start]: "13:00", [SHIFT_TYPES.end]: "16:00", [SHIFT_TYPES.order]: 2 } },
      { id: "recAfternoon0000", fields: { [SHIFT_TYPES.name]: "Afternoon", [SHIFT_TYPES.start]: "16:00", [SHIFT_TYPES.end]: "18:00", [SHIFT_TYPES.order]: 3 } },
    ],
    [SCHEDULE.table]: [
      { fields: { [SCHEDULE.date]: "2026-11-04", [SCHEDULE.shift]: ["recMorning000000"], [SCHEDULE.staff]: [SELMA, ASHA] } },
      { fields: { [SCHEDULE.date]: "2026-11-05", [SCHEDULE.shift]: ["recMorning000000"], [SCHEDULE.staff]: [ASHA] } },
    ],
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

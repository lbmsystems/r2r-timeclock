import test from "node:test";
import assert from "node:assert/strict";
import { localDate, zonedTime, weekStartDate, addDays, overlapMinutes, hhmmToMinutes } from "../src/time.js";

const NY = "America/New_York";

test("local date follows New York, not UTC", () => {
  // 11:30 PM Eastern on Nov 3 is already Nov 4 in UTC.
  assert.equal(localDate(new Date("2026-11-04T04:30:00Z"), NY), "2026-11-03");
  assert.equal(localDate(new Date("2026-11-04T05:30:00Z"), NY), "2026-11-04");
});

test("shift start times are right on both sides of the clock change", () => {
  // Daylight time ends Sunday Nov 1, 2026.
  assert.equal(zonedTime("2026-10-30", "07:00", NY).toISOString(), "2026-10-30T11:00:00.000Z");
  assert.equal(zonedTime("2026-11-02", "07:00", NY).toISOString(), "2026-11-02T12:00:00.000Z");
  // And it starts again Sunday Mar 8, 2026.
  assert.equal(zonedTime("2026-03-06", "16:00", NY).toISOString(), "2026-03-06T21:00:00.000Z");
  assert.equal(zonedTime("2026-03-09", "16:00", NY).toISOString(), "2026-03-09T20:00:00.000Z");
});

test("week starts on Sunday", () => {
  assert.equal(weekStartDate(new Date("2026-11-04T15:00:00Z"), NY, 0), "2026-11-01"); // Wed
  assert.equal(weekStartDate(new Date("2026-11-01T15:00:00Z"), NY, 0), "2026-11-01"); // Sun
  assert.equal(weekStartDate(new Date("2026-11-01T03:00:00Z"), NY, 0), "2026-10-25"); // Sat night local
});

test("helpers", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(hhmmToMinutes("07:00"), 420);
  assert.equal(hhmmToMinutes("bad"), null);
  const d = (s) => new Date(`2026-11-04T${s}:00Z`);
  assert.equal(overlapMinutes(d("10:00"), d("12:00"), d("11:00"), d("13:00")), 60);
  assert.equal(overlapMinutes(d("10:00"), d("11:00"), d("12:00"), d("13:00")), 0);
});

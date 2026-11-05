// Airtable layout for the "R2R Time Clock" base (Root to Rise workspace).
//
// Everything is addressed by ID, not by name, so renaming a table or a column
// in Airtable never breaks the time clock. If you ADD a column the Worker
// should read, put its ID here.

export const BASE_ID = "appN03Pyn2NzRRY95";

export const STAFF = {
  table: "tbl291vyuWjZqKEwc",
  name: "fld3hJvW2bwk7B2vd",
  active: "flddpOIqOhjCVn6hd",
  pinHash: "flddVt7Nh6ahL5zFi",
  newPin: "fldZuZbHu8w3JYIOJ",
  failedAttempts: "fldIReHtlqwddhHTl",
  lockedUntil: "fldq6PFmh5m2U5qJH",
  photo: "fldpTXPIB6c3DmdlB", // attachment; shown instead of the initial
};

export const SHIFT_TYPES = {
  table: "tblbWK5sHk4ikeatb",
  name: "fld9BGcYJFaAwuN6T",
  start: "fldCkisSermGUH2ar", // "07:00", 24-hour local time
  end: "fldEHx8ZdGfPPlv6b",
  order: "fldflRc6Y9qhP6nNb",
};

export const SCHEDULE = {
  table: "tblEtVsBqBTUQn78Q",
  date: "fldIRKn5ezhTFoT3l", // "YYYY-MM-DD"
  shift: "fldaQfgJJH8B1IJng", // link -> Shift Types
  staff: "fldkIIc1WAEnRgoRy", // link -> Staff
};

export const PUNCHES = {
  table: "tblJU06EDWGpmeB0K",
  staff: "fld5PpZEDOmZobUbF", // link -> Staff
  clockIn: "fldaDjlATeSfFXyn5",
  clockOut: "fldilhuxADHl8TpgY",
  source: "fldYD9CoD91QiWpL9", // "Kiosk" | "Manual fix"
  note: "fldVGBGXxzB3lXcU2",
  requestId: "fldqAQH98sH4r2ETw",
  editedBy: "fldDcaCYSgyNqzyny",
  editReason: "fldHobY4O9ZOXOyCz",
};

// A scheduled shift someone didn't work, recorded by an owner. The Schedule
// table is never changed, so it keeps showing who was meant to work.
export const ABSENCES = {
  table: "tblFXErDeDE1kOoB4",
  summary: "fldSKgQovyZKBoi7q",
  date: "fldteo428wl9AVyR1", // "YYYY-MM-DD"
  staff: "fldUraTvZX4wcOBRs", // link -> Staff
  shifts: "fld38N0I1251GA4DS", // link -> Shift Types
  reason: "fldTBBqtMyojsTdib", // one of ABSENCE_REASONS
  note: "fldzlSK4KpmVDDssh",
  recordedBy: "fldsoKl7unP21lKtn",
  recordedAt: "fldP3XGj96Gvf8D6g",
};

// Must match the Reason field's options in Airtable exactly. (A move to a
// different shift is not an absence: that is a schedule change, below.)
export const ABSENCE_REASONS = [
  "Called out sick",
  "No-show",
  "Personal / family",
  "Covered by someone else",
  "Shift cancelled",
  "Other",
];

// A log of shift changes made from the dashboard (Edit → Change shift). The
// Schedule table holds the current plan; this keeps what it was before.
export const SCHEDULE_CHANGES = {
  table: "tblobLQt45pVlGsVq",
  summary: "fldzlelVQHPuDoJ99",
  date: "flddD0yGobHGkrI8V",
  staff: "fldsdxjqPcOhklWl0",
  fromShift: "fldtNujMGZB9HRm2B",
  toShift: "flddxCt9qI7bdBrDz",
  note: "fldcdEYsvCG9MLEaw",
  changedBy: "fldIGRPZ207hvwNMA",
  changedAt: "fldnLlptOGgxDOJjR",
};

// Airtable, for links from the dashboard.
export const AIRTABLE_URL = "https://airtable.com/appN03Pyn2NzRRY95";

// Local time for every "today", "this week" and shift calculation. The
// Worker runs in UTC, so nothing may rely on the server's own clock zone.
export const TIME_ZONE = "America/New_York";

// 0 = Sunday. Used for the "this week" total on the clock-out screen.
export const WEEK_STARTS_ON = 0;

// A scheduled person shows as "not clocked in yet" this long after their
// shift starts.
export const LATE_GRACE_MINUTES = 15;

// Five wrong codes in a row lock that name for five minutes. Four digits is
// only 10,000 combinations, so this is what actually protects a code.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 5;

// A punch the kiosk saved while offline is accepted with the iPad's own
// timestamp only if it is no older than this. Anything older is refused and
// has to be entered by hand, so a stale queue can never rewrite history.
export const MAX_OFFLINE_AGE_HOURS = 12;

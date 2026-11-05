// Cloudflare Worker: serves the kiosk page (public/) and its API.
//
//   GET  /api/state  who is clocked in + today's schedule
//   GET  /api/schedule?date=YYYY-MM-DD  who is scheduled that day
//   POST /api/punch  { staffId, pin, requestId, at? } -> clock in or out
//
// Owners' dashboard, behind Cloudflare Access (see access.js):
//   GET   /admin/api/overview                     today: alerts, who's in
//   GET   /admin/api/hours?from=&to=              hours per person
//   GET   /admin/api/hours.csv?from=&to=          the same, for payroll
//   GET   /admin/api/week?start=YYYY-MM-DD        a week of schedule + attendance
//   POST  /admin/api/punches                      add a missed punch
//   PATCH /admin/api/punches/<record id>          fix a punch's times
//   POST  /admin/api/absences                     mark someone absent from a shift
//   DELETE /admin/api/absences/<record id>        undo that
//
// Secrets (set with `npx wrangler secret put NAME`):
//   AIRTABLE_TOKEN  personal access token, scoped to the R2R Time Clock base only
//   PIN_PEPPER      long random string; changing it invalidates every code

import { airtable, AirtableError } from "./airtable.js";
import { getState, getSchedule, punch, KioskError } from "./kiosk.js";
import { requireAdmin, AccessError } from "./access.js";
import {
  getOverview, getHours, hoursCsv, getWeek, updatePunch, createPunch, createAbsence, deleteAbsence, AdminError,
} from "./admin.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function handleApi(request, env, { fetchImpl, now } = {}) {
  const url = new URL(request.url);
  // Names only, never values, so a setup mistake can be spotted from the
  // kiosk or by opening /api/state in a browser.
  const missing = ["AIRTABLE_TOKEN", "PIN_PEPPER"].filter((k) => !env[k]);
  if (missing.length) return json(500, { error: "not_configured", missing });
  const at = airtable(env.AIRTABLE_TOKEN, fetchImpl ? { fetchImpl } : {});

  try {
    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(200, await getState(at, env, now?.()));
    }
    if (url.pathname === "/api/schedule" && request.method === "GET") {
      return json(200, await getSchedule(at, env, url.searchParams.get("date"), now?.()));
    }
    if (url.pathname === "/api/punch" && request.method === "POST") {
      // The kiosk page is served from this same origin. A browser on any
      // other site gets turned away here.
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json(403, { error: "forbidden" });
      let body;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "bad_json" });
      }
      return json(200, await punch(at, env, body, now?.()));
    }
    return json(404, { error: "not_found" });
  } catch (err) {
    if (err instanceof KioskError) return json(err.status, { error: err.code, ...err.extra });
    console.error(err);
    if (err instanceof AirtableError) return json(502, { error: "airtable_unavailable" });
    return json(500, { error: "server_error" });
  }
}

export async function handleAdmin(request, env, { fetchImpl, now } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin\/api/, "");
  const when = now?.() ?? new Date();
  try {
    const email = await requireAdmin(request, env, { ...(fetchImpl ? { fetchImpl } : {}), now: when });
    if (!env.AIRTABLE_TOKEN) return json(500, { error: "not_configured", missing: ["AIRTABLE_TOKEN"] });
    const at = airtable(env.AIRTABLE_TOKEN, fetchImpl ? { fetchImpl } : {});
    const q = url.searchParams;

    if (request.method === "GET") {
      if (path === "/overview") return json(200, { ...(await getOverview(at, when)), me: email });
      if (path === "/hours") return json(200, await getHours(at, q.get("from"), q.get("to"), when));
      if (path === "/hours.csv") {
        const result = await getHours(at, q.get("from"), q.get("to"), when);
        return new Response(hoursCsv(result), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="r2r-hours-${result.from}-to-${result.to}.csv"`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "/week") return json(200, await getWeek(at, q.get("start"), when));
      return json(404, { error: "not_found" });
    }

    // Changes only from the dashboard page itself.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json(403, { error: "forbidden" });
    const del = /^\/absences\/(rec[A-Za-z0-9]{14})$/.exec(path);
    if (request.method === "DELETE" && del) return json(200, await deleteAbsence(at, del[1]));
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "bad_json" });
    }
    if (request.method === "POST" && path === "/punches") return json(200, await createPunch(at, email, body, when));
    if (request.method === "POST" && path === "/absences") return json(200, await createAbsence(at, email, body, when));
    const m = /^\/punches\/(rec[A-Za-z0-9]{14})$/.exec(path);
    if (request.method === "PATCH" && m) return json(200, await updatePunch(at, email, m[1], body, when));
    return json(404, { error: "not_found" });
  } catch (err) {
    if (err instanceof AccessError || err instanceof AdminError) {
      return json(err.status, { error: err.code, ...(err.extra ?? {}) });
    }
    console.error(err);
    if (err instanceof AirtableError) return json(502, { error: "airtable_unavailable" });
    return json(500, { error: "server_error" });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/api/")) return handleAdmin(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};

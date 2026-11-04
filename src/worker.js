// Cloudflare Worker: serves the kiosk page (public/) and its API.
//
//   GET  /api/state  who is clocked in + today's schedule
//   POST /api/punch  { staffId, pin, requestId, at? } -> clock in or out
//
// Secrets (set with `npx wrangler secret put NAME`):
//   AIRTABLE_TOKEN  personal access token, scoped to the R2R Time Clock base only
//   PIN_PEPPER      long random string; changing it invalidates every code

import { airtable, AirtableError } from "./airtable.js";
import { getState, punch, KioskError } from "./kiosk.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function handleApi(request, env, { fetchImpl, now } = {}) {
  const url = new URL(request.url);
  if (!env.AIRTABLE_TOKEN || !env.PIN_PEPPER) return json(500, { error: "not_configured" });
  const at = airtable(env.AIRTABLE_TOKEN, fetchImpl ? { fetchImpl } : {});

  try {
    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(200, await getState(at, env, now?.()));
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};

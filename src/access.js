// Who is using the owners' dashboard.
//
// Cloudflare Access sits in front of /admin and signs each request it lets
// through with a JWT (the Cf-Access-Jwt-Assertion header). The Worker checks
// that signature against the Access team's public keys, the audience tag,
// and the expiry, so a request that did not come through Access, or a
// forged header, gets nothing.
//
// Settings (Worker → Settings → Variables and Secrets):
//   ACCESS_TEAM_DOMAIN  e.g. "roottorise.cloudflareaccess.com"
//   ACCESS_AUD          the Access application's "Application Audience (AUD) Tag"
//   ADMIN_EMAILS        optional: comma-separated emails allowed in, on top of
//                       Access's own policy
//
// Without the first two, every dashboard request is refused: the dashboard
// stays locked until Access protects it.

export class AccessError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const KEYS_TTL_MS = 60 * 60 * 1000;
let keysCache = { domain: "", at: 0, keys: [] };
export function resetAccessCache() { keysCache = { domain: "", at: 0, keys: [] }; }

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function signingKeys(domain, fetchImpl) {
  if (keysCache.domain === domain && Date.now() - keysCache.at < KEYS_TTL_MS) return keysCache.keys;
  const res = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessError(503, "access_keys_unavailable");
  const { keys = [] } = await res.json();
  keysCache = { domain, at: Date.now(), keys };
  return keys;
}

function tokenFrom(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1] : "";
}

/**
 * The signed-in owner's email, or an AccessError.
 * Local development only: INSECURE_DEV_ADMIN_EMAIL is honoured for requests
 * to localhost, so the dashboard can be tried with `npm run dev`.
 */
export async function requireAdmin(request, env, { fetchImpl = fetch, now = new Date() } = {}) {
  const url = new URL(request.url);
  if (env.INSECURE_DEV_ADMIN_EMAIL && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return env.INSECURE_DEV_ADMIN_EMAIL;
  }

  const domain = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const aud = String(env.ACCESS_AUD || "").trim();
  if (!domain || !aud) throw new AccessError(503, "dashboard_not_protected");

  const token = tokenFrom(request);
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError(401, "not_signed_in");

  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new AccessError(401, "not_signed_in");
  }
  if (header.alg !== "RS256") throw new AccessError(401, "not_signed_in");

  const jwk = (await signingKeys(domain, fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessError(401, "not_signed_in");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new AccessError(401, "not_signed_in");

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const nowSec = Math.floor(now.getTime() / 1000);
  if (!auds.includes(aud)) throw new AccessError(401, "not_signed_in");
  if (payload.iss !== `https://${domain}`) throw new AccessError(401, "not_signed_in");
  if (!payload.exp || payload.exp < nowSec - 60) throw new AccessError(401, "not_signed_in");
  if (payload.nbf && payload.nbf > nowSec + 60) throw new AccessError(401, "not_signed_in");

  const email = String(payload.email || "").toLowerCase();
  if (!email) throw new AccessError(401, "not_signed_in");
  const allowed = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(email)) throw new AccessError(403, "not_an_owner");
  return email;
}

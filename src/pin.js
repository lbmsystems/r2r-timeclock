// Staff codes are never stored as typed. Airtable holds
//   v1:<hex HMAC-SHA256(PIN_PEPPER, "<staff record id>:<code>")>
// PIN_PEPPER is a Worker secret, so someone who can read the base still
// cannot test codes against the hashes, and the same code for two people
// hashes differently.

const enc = new TextEncoder();

export const isValidPin = (pin) => /^\d{4}$/.test(String(pin ?? ""));

export async function hashPin(pepper, staffId, pin) {
  if (!pepper) throw new Error("PIN_PEPPER is not set");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${staffId}:${pin}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v1:${hex}`;
}

export async function pinMatches(pepper, staffId, pin, storedHash) {
  if (!storedHash || !isValidPin(pin)) return false;
  const candidate = await hashPin(pepper, staffId, pin);
  if (candidate.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ storedHash.charCodeAt(i);
  return diff === 0;
}

// A small Airtable REST client. Every read asks for fields by ID
// (returnFieldsByFieldId), matching the IDs in config.js.

import { BASE_ID } from "./config.js";

export class AirtableError extends Error {
  constructor(status, body) {
    super(`Airtable ${status}: ${body}`);
    this.status = status;
  }
}

// Airtable allows 5 requests per second per base and answers 429 above that.
// A short wait and a retry turns a burst (a punch, then the kiosk refreshing)
// into a slightly slower reply instead of an error on the iPad.
const RETRY_DELAYS_MS = [1000, 2000];

export function airtable(token, { baseId = BASE_ID, fetchImpl = fetch, retryDelays = RETRY_DELAYS_MS } = {}) {
  const root = `https://api.airtable.com/v0/${baseId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${root}/${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw new AirtableError(0, `unreachable: ${err.message}`); // network, DNS, timeout
      }
      if (res.status === 429 && attempt < retryDelays.length) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      if (!res.ok) throw new AirtableError(res.status, await res.text());
      return res.json();
    }
  }

  return {
    /** Every record matching `filterByFormula` (all pages). */
    async list(table, { filterByFormula } = {}) {
      const records = [];
      let offset;
      do {
        const q = new URLSearchParams({ returnFieldsByFieldId: "true", pageSize: "100" });
        if (filterByFormula) q.set("filterByFormula", filterByFormula);
        if (offset) q.set("offset", offset);
        const page = await call("GET", `${table}?${q}`);
        records.push(...page.records);
        offset = page.offset;
      } while (offset);
      return records;
    },

    async create(table, fields) {
      const res = await call("POST", `${table}?returnFieldsByFieldId=true`, {
        records: [{ fields }],
      });
      return res.records[0];
    },

    async remove(table, id) {
      return call("DELETE", `${table}/${id}`);
    },

    async update(table, id, fields) {
      const res = await call("PATCH", `${table}?returnFieldsByFieldId=true`, {
        records: [{ id, fields }],
      });
      return res.records[0];
    },
  };
}

/** Quote a value for use inside an Airtable formula string. */
export function formulaString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

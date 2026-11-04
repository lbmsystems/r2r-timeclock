// A small Airtable REST client. Every read asks for fields by ID
// (returnFieldsByFieldId), matching the IDs in config.js.

import { BASE_ID } from "./config.js";

export class AirtableError extends Error {
  constructor(status, body) {
    super(`Airtable ${status}: ${body}`);
    this.status = status;
  }
}

export function airtable(token, { baseId = BASE_ID, fetchImpl = fetch } = {}) {
  const root = `https://api.airtable.com/v0/${baseId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function call(method, path, body) {
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
    if (!res.ok) throw new AirtableError(res.status, await res.text());
    return res.json();
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

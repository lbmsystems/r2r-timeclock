// An in-memory stand-in for the Airtable REST API, enough for the Worker's
// own calls. It understands only the formula shapes the Worker sends, and
// throws on anything else so a new query can't silently match everything.

import { BASE_ID } from "../src/config.js";

let seq = 0;
const newId = () => "rec" + String(++seq).padStart(14, "0");

export function fakeAirtable(tables) {
  const db = {};
  for (const [table, rows] of Object.entries(tables)) {
    db[table] = rows.map((r) => ({ id: r.id ?? newId(), createdTime: new Date().toISOString(), fields: { ...r.fields } }));
  }

  function splitTopLevel(inner) {
    const parts = [];
    let depth = 0, quote = false, start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "'" && inner[i - 1] !== "\\") quote = !quote;
      if (quote) continue;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) { parts.push(inner.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(inner.slice(start).trim());
    return parts;
  }

  function matches(rec, formula) {
    if (!formula) return true;
    let m;
    if (formula.startsWith("OR(") && formula.endsWith(")")) {
      return splitTopLevel(formula.slice(3, -1)).some((f) => matches(rec, f));
    }
    if ((m = /^\{(fld\w+)\} = BLANK\(\)$/.exec(formula))) {
      const v = rec.fields[m[1]];
      return v === undefined || v === null || v === "";
    }
    if ((m = /^IS_AFTER\(\{(fld\w+)\}, DATETIME_PARSE\('([^']+)'\)\)$/.exec(formula))) {
      const v = rec.fields[m[1]];
      return Boolean(v) && new Date(v) > new Date(m[2]);
    }
    if ((m = /^DATETIME_FORMAT\(\{(fld\w+)\}, 'YYYY-MM-DD'\) = '([^']+)'$/.exec(formula))) {
      return rec.fields[m[1]] === m[2];
    }
    if ((m = /^RECORD_ID\(\) = '([^']+)'$/.exec(formula))) return rec.id === m[1];
    if ((m = /^\{(fld\w+)\} = '([^']*)'$/.exec(formula))) return (rec.fields[m[1]] ?? "") === m[2];
    throw new Error("fake Airtable: unsupported formula " + formula);
  }

  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const [, , base, table] = u.pathname.split("/");
    if (base !== BASE_ID) throw new Error("wrong base " + base);
    if (!db[table]) return new Response("no table", { status: 404 });
    const method = init.method ?? "GET";
    calls.push({ method, table, formula: u.searchParams.get("filterByFormula") });
    const strip = (r) => {
      const fields = {};
      for (const [k, v] of Object.entries(r.fields)) if (v !== null && v !== "" && v !== undefined) fields[k] = v;
      return { id: r.id, createdTime: r.createdTime, fields };
    };

    if (method === "GET") {
      const f = u.searchParams.get("filterByFormula");
      return Response.json({ records: db[table].filter((r) => matches(r, f)).map(strip) });
    }
    const body = JSON.parse(init.body);
    if (method === "POST") {
      const made = body.records.map((r) => {
        const rec = { id: newId(), createdTime: new Date().toISOString(), fields: { ...r.fields } };
        db[table].push(rec);
        return strip(rec);
      });
      return Response.json({ records: made });
    }
    if (method === "PATCH") {
      const out = body.records.map((r) => {
        const rec = db[table].find((x) => x.id === r.id);
        if (!rec) throw new Error("no record " + r.id);
        Object.assign(rec.fields, r.fields);
        return strip(rec);
      });
      return Response.json({ records: out });
    }
    return new Response("bad method", { status: 405 });
  }

  return { db, fetchImpl, calls };
}

#!/usr/bin/env node
// Assembles one OpenAPI document for the Retavon API, which serves its description only a piece at
// a time (GET /openapi, /openapi/operations/{id}, /openapi/schemas/{name}) and only with a key.
//
// Usage: RETAVON_API_KEY=... node scripts/fetch-retavon-spec.mjs <out-dir>
//
// Writes <out-dir>/retavon-openapi.json and caches each read under <out-dir>/raw, so a run that
// stops can be started again. The document holds the operations the key's business can see;
// those of features it has off are left out by the API. Where a proxy adds the key to requests,
// RETAVON_API_KEY can be left unset. The result is Retavon's document: do not commit it.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2];
if (!out) {
  console.error('usage: fetch-retavon-spec.mjs <out-dir>');
  process.exit(2);
}
const BASE = 'https://api.retavon.com';
const KEY = process.env.RETAVON_API_KEY || 'placeholder';
if (!/^[A-Za-z0-9._~+/=-]+$/.test(KEY)) {
  console.error('RETAVON_API_KEY has characters a bearer token cannot hold');
  process.exit(2);
}
 const raw = join(out, 'raw'); mkdirSync(raw, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, cacheName) {
  const f = join(raw, cacheName.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  for (let i = 0; i < 6; i++) {
    // The key goes to curl on standard input, so it never shows in the process list.
    const res = execFileSync('curl', ['-sS', '-m', '60', '-w', '\n%{http_code}', '-K', '-', BASE + path], { input: `header = "Authorization: Bearer ${KEY}"\n`, encoding: 'utf8', maxBuffer: 1 << 28 });
    const cut = res.lastIndexOf('\n'); const code = res.slice(cut + 1); const body = res.slice(0, cut);
    if (code === '200') { writeFileSync(f, body); return JSON.parse(body); }
    if (code === '429' || code === '503') { await sleep(3000 * (i + 1)); continue; }
    throw new Error(`${path}: ${code} ${body.slice(0, 200)}`);
  }
  throw new Error(`${path}: gave up`);
}
const cat = await get('/openapi/operations', '_catalog');
const ids = cat.operations.map((l) => l.split(' ')[0]);
const doc = { openapi: '3.1.0', info: null, servers: [{ url: BASE }], security: null, tags: [], paths: {}, components: { schemas: {}, securitySchemes: {} } };
const map = await get('/openapi', '_map');
doc.tags = map.tags.map((t) => ({ name: t.name, description: t.description }));
const want = new Set(); const conflicts = [];
const addSchema = (n, s) => { const have = doc.components.schemas[n]; if (have && JSON.stringify(have) !== JSON.stringify(s)) conflicts.push(n); else doc.components.schemas[n] = s; };
let n = 0;
for (const id of ids) {
  const frag = await get('/openapi/operations/' + encodeURIComponent(id), 'op_' + id);
  doc.info ??= frag.info; doc.security ??= frag.security;
  for (const [p, item] of Object.entries(frag.paths ?? {})) {
    doc.paths[p] ??= {};
    for (const [m, op] of Object.entries(item)) {
      // Fragment-level extensions describe this one operation; keep them on it.
      for (const k of ['x-errors', 'x-response-fields']) if (frag[k] !== undefined) op[k] = frag[k];
      doc.paths[p][m] = op;
    }
  }
  for (const [name, s] of Object.entries(frag.components?.schemas ?? {})) addSchema(name, s);
  Object.assign(doc.components.securitySchemes, frag.components?.securitySchemes ?? {});
  for (const name of Object.keys(frag['x-schemas-elsewhere'] ?? {})) want.add(name);
  if (++n % 50 === 0) console.error(`operations ${n}/${ids.length}`);
}
// Schemas named but not inlined, and whatever they reference in turn.
const refs = (o, acc) => { if (o && typeof o === 'object') { if (typeof o.$ref === 'string') acc.add(o.$ref.replace('#/components/schemas/', '')); for (const v of Object.values(o)) refs(v, acc); } return acc; };
for (;;) {
  for (const r of refs(doc, new Set())) want.add(r);
  const todo = [...want].filter((x) => !(x in doc.components.schemas));
  if (!todo.length) break;
  for (const name of todo) { const s = await get('/openapi/schemas/' + encodeURIComponent(name), 'schema_' + name); addSchema(name, s.schema); }
  console.error(`schemas ${Object.keys(doc.components.schemas).length}`);
}
writeFileSync(join(out, 'retavon-openapi.json'), JSON.stringify(doc, null, 1));
console.log(JSON.stringify({ operations: ids.length, paths: Object.keys(doc.paths).length, schemas: Object.keys(doc.components.schemas).length, conflicts }));

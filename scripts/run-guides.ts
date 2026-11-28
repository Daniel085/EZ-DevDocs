#!/usr/bin/env node
// Runs the calls of generated guides against a real API, to find out whether the flows work.
// A development tool: it is not part of the module, which never touches the network.
//
// Usage:
//   GUIDES_API_KEY=... node scripts/run-guides.ts <bundle-dir> --spec <spec> [--base-url <url>]
//       [--only <regex>] [--skip <regex>] [--out <results.json>] [--dry-run] [--vary]
//
// Every <Sample> on a page is sent in order. Captured values are carried into later samples, as
// the portal would. A page passes when every call answers below 400. --vary changes an example value
// the API refuses as already taken and tries again, and reports such pages separately. THIS MAKES REAL CALLS,
// including ones that create, change and delete records: point it at a sandbox.
//
// The key is sent as `Authorization: Bearer`. Where a proxy adds the credential, leave
// GUIDES_API_KEY unset. Responses are untrusted: only the status and a short excerpt are kept.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadSpec, type Json, type Operation } from '../src/spec.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const bundle = args.find((a, i) => !a.startsWith('--') && !['--spec', '--base-url', '--only', '--skip', '--out'].includes(args[i - 1] ?? ''));
if (!bundle || !option('--spec')) {
  console.error('usage: run-guides.ts <bundle-dir> --spec <spec> [--base-url <url>] [--only <regex>] [--skip <regex>] [--out <file>] [--dry-run]');
  process.exit(2);
}
const model = loadSpec(readFileSync(option('--spec')!));
const baseUrl = (option('--base-url') ?? model.servers[0]?.url ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(baseUrl)) {
  console.error(`No https base URL: '${baseUrl}'. Pass --base-url.`);
  process.exit(2);
}
const key = process.env.GUIDES_API_KEY || 'placeholder';
if (!/^[A-Za-z0-9._~+/=-]+$/.test(key)) {
  console.error('GUIDES_API_KEY has characters a bearer token cannot hold');
  process.exit(2);
}
const only = option('--only') ? new RegExp(option('--only')!) : undefined;
const skip = option('--skip') ? new RegExp(option('--skip')!) : undefined;
const dryRun = args.includes('--dry-run');
const vary = args.includes('--vary');
const runTag = Math.random().toString(36).slice(2, 6);

/**
 * Changes the value an API refused as already taken. The refusal is searched for quoted values
 * that appear in the request; failing that, phone numbers and email addresses are changed.
 * Phone numbers stay in the 555-01xx range, which is reserved for fiction in every area code.
 */
function varyValues(values: Json, refusal: string): boolean {
  const quoted = [...refusal.matchAll(/"([^"]{1,80})"/g)].map((m) => m[1]!);
  let changed = false;
  const n = Math.floor(Math.random() * 1e6);
  const walkValue = (v: Json): Json => {
    if (typeof v === 'string') {
      if (quoted.includes(v)) {
        changed = true;
        return /^[A-Z0-9]{2,8}$/.test(v) ? Array.from({ length: Math.max(v.length, 6) }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('') : /^\d+$/.test(v) ? String(Number(v) + 1 + (n % 900)) : /\s/.test(v) ? `${v} ${runTag}${n}` : `${v}-${runTag}${n}`;
      }
      if (quoted.length === 0 && /^\+1\d{10}$/.test(v)) {
        changed = true;
        return `+1${200 + (n % 700)}55501${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
      }
      if (quoted.length === 0 && /^[^@\s]+@[^@\s]+$/.test(v)) {
        changed = true;
        return v.replace('@', `+${runTag}${n % 100}@`);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walkValue);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkValue(x)]));
    return v;
  };
  if (values.body !== undefined) values.body = walkValue(values.body);
  return changed;
}


interface Sample {
  operation: string;
  example?: string;
  capture: [string, string][];
  values: Json;
  line: number;
}

/** The samples of a page, in order. The bundle is assumed to have passed validation. */
function samplesOf(text: string): Sample[] {
  const out: Sample[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}<Sample\b((?:[^>"]|"[^"]*")*?)(\/?)>\s*$/.exec(lines[i]!);
    if (!m) continue;
    const attrs = Object.fromEntries([...m[1]!.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));
    const sample: Sample = { operation: attrs.operation ?? '', example: attrs.example, capture: (attrs.capture ?? '').split(' ').filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as [string, string]), values: undefined, line: i + 1 };
    if (!m[2]) {
      const start = lines.findIndex((l, k) => k > i && /^ {0,3}```json\s*$/.test(l));
      const end = lines.findIndex((l, k) => k > start && /^ {0,3}```\s*$/.test(l));
      if (start > 0 && end > start) sample.values = JSON.parse(lines.slice(start + 1, end).join('\n'));
    }
    out.push(sample);
  }
  return out;
}

/** Fills variables in. A string that is exactly one variable takes the value's own type (contract 4.6). */
function substitute(value: Json, vars: Map<string, Json>, missing: Set<string>): Json {
  if (typeof value === 'string') {
    const whole = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(value);
    const get = (name: string) => {
      if (name === 'idempotency_key') return randomUUID();
      if (!vars.has(name)) missing.add(name);
      return vars.get(name);
    };
    if (whole) return get(whole[1]!);
    return value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, n) => String(get(n) ?? ''));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars, missing)]));
  return value;
}

function exampleValues(op: Operation, name: string): Json {
  const values: Json = {};
  if (op.requestBody && name in op.requestBody.examples) values.body = op.requestBody.examples[name];
  for (const p of op.parameters) {
    if (p.in === 'cookie' || !(name in p.examples)) continue;
    (values[p.in === 'path' ? 'path' : p.in === 'query' ? 'query' : 'headers'] ??= {})[p.name] = p.examples[name];
  }
  return values;
}

/** Reads a capture path: `$`, `.member` and `[index]` only. */
function read(body: Json, path: string): Json {
  let cur = body;
  for (const m of path.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = m[1] !== undefined ? (Object.hasOwn(cur, m[1]) ? cur[m[1]] : undefined) : cur[Number(m[2])];
  }
  return ['string', 'number', 'boolean'].includes(typeof cur) && String(cur).length <= 2048 ? cur : undefined;
}

function send(op: Operation, values: Json): { status: number; body: Json; excerpt: string } {
  let path = op.path;
  for (const [k, v] of Object.entries(values.path ?? {})) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  const query = Object.entries(values.query ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`));
  const url = baseUrl + path + (query.length ? '?' + query.join('&') : '');
  const config = [`header = "Authorization: Bearer ${key}"`, `request = "${op.method.toUpperCase()}"`];
  for (const [k, v] of Object.entries(values.headers ?? {})) config.push(`header = "${k}: ${String(v).replace(/["\\\r\n]/g, '')}"`);
  let data: string | undefined;
  if (values.body !== undefined) {
    const form = /x-www-form-urlencoded/i.test(op.requestBody?.contentType ?? '');
    data = form ? Object.entries(values.body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`).join('&') : JSON.stringify(values.body);
    config.push(`header = "Content-Type: ${form ? 'application/x-www-form-urlencoded' : 'application/json'}"`);
    config.push(`data-binary = "${data.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`);
  }
  for (let attempt = 0; ; attempt++) {
    // The key and the body go to curl in a config read from standard input, never on the command line.
    const res = execFileSync('curl', ['-sS', '-m', '60', '-w', '\n%{http_code}', '-K', '-', url], { input: config.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 26 });
    const cut = res.lastIndexOf('\n');
    const status = Number(res.slice(cut + 1));
    if ((status === 429 || status === 503) && attempt < 3) {
      execFileSync('sleep', [String(5 * (attempt + 1))]);
      continue;
    }
    let body: Json;
    try {
      body = JSON.parse(res.slice(0, cut));
    } catch {
      body = undefined;
    }
    const excerpt = body && typeof body === 'object' && !Array.isArray(body) ? [body.code, body.detail ?? body.message ?? body.title].filter((x) => typeof x === 'string').join(': ').slice(0, 300) : '';
    return { status, body, excerpt };
  }
}

const pages: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.md')) pages.push(relative(join(bundle, 'pages'), full).split(sep).join('/').replace(/\.md$/, ''));
  }
};
walk(join(bundle, 'pages'));

const results: Json[] = [];
for (const page of pages) {
  if ((only && !only.test(page)) || (skip && skip.test(page))) continue;
  const samples = samplesOf(readFileSync(join(bundle, 'pages', page + '.md'), 'utf8'));
  if (samples.length === 0) continue;
  const vars = new Map<string, Json>();
  const steps: Json[] = [];
  let emptyList = false;
  for (const s of samples) {
    const op = model.operationsById.get(s.operation);
    if (!op) {
      steps.push({ operation: s.operation, outcome: 'unknown operation' });
      break;
    }
    const missing = new Set<string>();
    const merged = { ...(s.example ? exampleValues(op, s.example) : {}), ...(s.values ?? {}) };
    const values = substitute(merged, vars, missing);
    if (missing.size) {
      steps.push({ operation: op.id, outcome: 'not sent', reason: `no value for ${[...missing].join(', ')}: an earlier call did not yield it` });
      continue;
    }
    if (dryRun) {
      steps.push({ operation: op.id, outcome: 'dry run', method: op.method, path: op.path });
      continue;
    }
    let res = send(op, values);
    // A spec's example values are fixed, so a guide that creates a record with a unique field can
    // run once per business. With --vary, a refused value is changed and the call sent again, so the
    // rest of the flow can be judged. The step is then reported as 'ok after varying', not 'ok'.
    let varied = false;
    for (let attempt = 0; vary && res.status === 409 && attempt < 4; attempt++) {
      const changed = varyValues(values, res.excerpt);
      if (!changed) break;
      varied = true;
      res = send(op, values);
    }
    const ok = res.status > 0 && res.status < 400;
    for (const [name, path] of s.capture) {
      const v = ok ? read(res.body, path) : undefined;
      if (v !== undefined) vars.set(name, v);
      else if (ok && /\[0\]/.test(path) && op.method === 'get') emptyList = true;
      else if (ok) steps.push({ operation: op.id, outcome: 'capture failed', reason: `${path} is not in the response` });
    }
    steps.push({ operation: op.id, method: op.method.toUpperCase(), status: res.status, outcome: !ok ? 'failed' : varied ? 'ok after varying' : 'ok', ...(ok ? {} : { detail: res.excerpt }) });
    if (emptyList) break;
  }
  const fine = (o: string) => o === 'ok' || o === 'dry run' || o === 'ok after varying';
  const verdict = !steps.every((s) => fine(s.outcome)) ? 'FAIL' : emptyList ? 'empty' : steps.some((s) => s.outcome === 'ok after varying') ? 'varied' : 'pass';
  results.push({ page, verdict, steps });
  const bad = steps.find((s) => !fine(s.outcome));
  console.log(`${verdict.padEnd(6)} ${page}  (${steps.filter((s) => fine(s.outcome)).length}/${samples.length} calls ok)${bad ? `  ${bad.operation}: ${bad.status ?? ''} ${bad.detail ?? bad.reason ?? bad.outcome}`.slice(0, 260) : ''}`);
}
const count = (v: string) => results.filter((r) => r.verdict === v).length;
console.log(`\n${results.length} pages: ${count('pass')} passed as written, ${count('varied')} passed only after an example value was varied, ${count('empty')} had nothing to list, ${count('FAIL')} failed.`);
const passed = results.length - count('FAIL');
if (option('--out')) writeFileSync(option('--out')!, JSON.stringify({ baseUrl, pages: results }, null, 2) + '\n');
process.exitCode = passed === results.length ? 0 : 1;

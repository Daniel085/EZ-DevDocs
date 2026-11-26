// Sample values: synthesizing them from schemas, and validating them against an operation.
// The same validation runs in the generator (before a sample is emitted) and in the bundle validator.

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { deref, type Json, type Operation, type SpecModel } from './spec.ts';

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;

export interface SampleValues {
  path?: Record<string, Json>;
  query?: Record<string, Json>;
  headers?: Record<string, Json>;
  body?: Json;
}

const SPEC_ID = 'https://spec.invalid/openapi';
const VAR = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

export const hasVariable = (v: Json): boolean => typeof v === 'string' && VAR.test(v);

// ---------------------------------------------------------------------------------------------
// Validation

/** Clones a schema, pointing local refs at the registered spec and smoothing over 3.0 keywords. */
function prepare(node: Json, is30: boolean, rewriteRefs: boolean): Json {
  if (Array.isArray(node)) return node.map((n) => prepare(n, is30, rewriteRefs));
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') out[k] = rewriteRefs && v.startsWith('#/') ? SPEC_ID + v : v;
    else out[k] = prepare(v, is30, rewriteRefs);
  }
  if (is30) {
    for (const [flag, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
      if (out[flag] === true && typeof out[bound] === 'number') {
        out[flag] = out[bound];
        delete out[bound];
      } else if (typeof out[flag] === 'boolean') delete out[flag];
    }
  }
  return out;
}

export class SchemaChecker {
  private ajv: any;
  private is30: boolean;
  private cache = new Map<Json, ((v: Json) => boolean) | null>();

  constructor(model: SpecModel) {
    this.is30 = model.openapi.startsWith('3.0');
    this.ajv = new Ajv2020({ strict: false, allErrors: true, logger: false, validateFormats: true });
    addFormats(this.ajv);
    try {
      this.ajv.addSchema({ $id: SPEC_ID, components: prepare(model.doc.components ?? {}, this.is30, false) });
    } catch {
      // Refs into components will fail to compile and be reported per sample.
    }
  }

  /** Returns error messages, or null when the schema itself could not be compiled. */
  check(schema: Json, value: Json): { instancePath: string; message: string }[] | null {
    if (schema === undefined || schema === null) return [];
    let fn = this.cache.get(schema);
    if (fn === undefined) {
      try {
        fn = this.ajv.compile(prepare(schema, this.is30, true));
      } catch {
        fn = null;
      }
      this.cache.set(schema, fn!);
    }
    if (!fn) return null;
    if (fn(value)) return [];
    return ((fn as any).errors ?? []).map((e: Json) => ({ instancePath: e.instancePath, message: e.message ?? 'invalid' }));
  }
}

function variablePaths(value: Json, base = '', out: string[] = []): string[] {
  if (hasVariable(value)) out.push(base);
  else if (Array.isArray(value)) value.forEach((v, i) => variablePaths(v, `${base}/${i}`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) variablePaths(v, `${base}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
  }
  return out;
}

/** Checks inline sample values against the operation. Returns human-readable problems. */
export function validateSampleValues(op: Operation, values: Json, checker: SchemaChecker): string[] {
  const errors: string[] = [];
  if (!values || typeof values !== 'object' || Array.isArray(values)) return ['Sample values must be a JSON object.'];
  for (const key of Object.keys(values)) {
    if (!['path', 'query', 'headers', 'body'].includes(key)) errors.push(`Unknown key '${key}'. Expected path, query, headers or body.`);
  }
  const groups: [keyof SampleValues, string][] = [['path', 'path'], ['query', 'query'], ['headers', 'header']];
  for (const [key, loc] of groups) {
    const given = values[key] ?? {};
    if (typeof given !== 'object' || Array.isArray(given)) {
      errors.push(`'${key}' must be an object.`);
      continue;
    }
    const params = op.parameters.filter((p) => p.in === loc);
    const same = (a: string, b: string) => (loc === 'header' ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (const name of Object.keys(given)) {
      const param = params.find((p) => same(p.name, name));
      if (!param) {
        errors.push(`'${name}' is not a ${loc} parameter of ${op.id}.`);
        continue;
      }
      const v = given[name];
      if (hasVariable(v)) continue;
      const res = checker.check(param.schema, v);
      if (res === null) errors.push(`The schema of ${loc} parameter '${name}' could not be compiled.`);
      else for (const e of res) errors.push(`${loc} parameter '${name}' ${e.message}.`);
    }
    for (const p of params) {
      if (p.required && !Object.keys(given).some((n) => same(p.name, n))) errors.push(`Required ${loc} parameter '${p.name}' is missing.`);
    }
  }
  const hasBody = 'body' in values && values.body !== undefined;
  if (hasBody && !op.requestBody) errors.push(`${op.id} does not take a request body.`);
  if (!hasBody && op.requestBody?.required) errors.push(`${op.id} requires a request body.`);
  if (hasBody && op.requestBody) {
    const res = checker.check(op.requestBody.schema, values.body);
    if (res === null) errors.push('The request body schema could not be compiled.');
    else {
      const skip = variablePaths(values.body);
      for (const e of res) {
        if (skip.some((p) => e.instancePath === p)) continue;
        // A variable inside a oneOf/anyOf branch produces errors on the parent too; those cannot be judged.
        if (skip.length && /must match|oneOf|anyOf/.test(e.message)) continue;
        errors.push(`body${e.instancePath} ${e.message}.`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Synthesis

export interface Synth {
  ok: boolean;
  value?: Json;
  /** True when a value was made up from the type alone, with no example, default or enum behind it. */
  placeholder: boolean;
}

const FAIL: Synth = { ok: false, placeholder: false };
const STRING_FORMATS: Record<string, string> = {
  'date-time': '2026-01-15T09:30:00Z',
  date: '2026-01-15',
  time: '09:30:00Z',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
};

function typeOf(s: Json): string | undefined {
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  if (t) return t;
  if (s.properties || s.additionalProperties) return 'object';
  if (s.items) return 'array';
  return undefined;
}

/** Builds a request value for a schema. Prefers examples, defaults and enums; falls back to placeholders. */
export function synthesize(doc: Json, schema: Json, depth = 0): Synth {
  const s = deref(doc, schema);
  if (!s || typeof s !== 'object' || depth > 6) return FAIL;
  if (s.example !== undefined) return { ok: true, value: s.example, placeholder: false };
  if (Array.isArray(s.examples) && s.examples.length) return { ok: true, value: s.examples[0], placeholder: false };
  if (s.const !== undefined) return { ok: true, value: s.const, placeholder: false };
  if (s.default !== undefined && s.default !== null) return { ok: true, value: s.default, placeholder: false };
  if (Array.isArray(s.enum) && s.enum.length) return { ok: true, value: s.enum.find((v: Json) => v !== null) ?? s.enum[0], placeholder: false };

  if (Array.isArray(s.allOf) && s.allOf.length) {
    const { allOf, ...rest } = s;
    const parts = [...allOf, ...(Object.keys(rest).some((k) => ['properties', 'type', 'required'].includes(k)) ? [rest] : [])];
    let value: Json;
    let placeholder = false;
    for (const part of parts) {
      const r = synthesize(doc, part, depth + 1);
      if (!r.ok) return FAIL;
      placeholder ||= r.placeholder;
      if (r.value && typeof r.value === 'object' && !Array.isArray(r.value)) value = { ...(value ?? {}), ...r.value };
      else if (value === undefined) value = r.value;
    }
    return { ok: true, value, placeholder };
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(s[key]) && s[key].length) {
      for (const alt of s[key]) {
        if (deref(doc, alt)?.type === 'null') continue;
        const r = synthesize(doc, alt, depth + 1);
        if (r.ok) return r;
      }
      return FAIL;
    }
  }

  switch (typeOf(s)) {
    case 'object': {
      const props: Record<string, Json> = s.properties ?? {};
      const required: string[] = Array.isArray(s.required) ? s.required : [];
      const value: Record<string, Json> = {};
      let placeholder = false;
      const usable = (p: Json) => p && typeof p === 'object' && p.readOnly !== true;
      for (const [name, raw] of Object.entries(props)) {
        const p = deref(doc, raw);
        if (!usable(p)) continue;
        const isRequired = required.includes(name);
        if (!isRequired && p.example === undefined) continue;
        const r = synthesize(doc, raw, depth + 1);
        if (!r.ok) {
          if (isRequired) return FAIL;
          continue;
        }
        value[name] = r.value;
        placeholder ||= r.placeholder;
      }
      if (required.some((n) => !(n in value) && deref(doc, props[n])?.readOnly !== true)) return FAIL;
      if (Object.keys(value).length === 0) {
        // Nothing required and no examples: show a few simple optional fields rather than an empty object.
        for (const [name, raw] of Object.entries(props)) {
          const p = deref(doc, raw);
          if (!usable(p) || !['string', 'integer', 'number', 'boolean'].includes(typeOf(p) ?? '')) continue;
          const r = synthesize(doc, raw, depth + 1);
          if (!r.ok) continue;
          value[name] = r.value;
          placeholder ||= r.placeholder;
          if (Object.keys(value).length >= 3) break;
        }
      }
      return { ok: true, value, placeholder };
    }
    case 'array': {
      if (!s.items) return { ok: true, value: [], placeholder: false };
      const r = synthesize(doc, s.items, depth + 1);
      if (!r.ok) return (s.minItems ?? 0) > 0 ? FAIL : { ok: true, value: [], placeholder: false };
      return { ok: true, value: Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => r.value), placeholder: r.placeholder };
    }
    case 'string': {
      if (s.format === 'binary' || s.format === 'byte') return FAIL;
      let v = STRING_FORMATS[s.format] ?? 'string';
      if (!STRING_FORMATS[s.format]) {
        if (typeof s.minLength === 'number' && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
        if (typeof s.maxLength === 'number' && v.length > s.maxLength) v = v.slice(0, s.maxLength);
      }
      return { ok: true, value: v, placeholder: true };
    }
    case 'integer':
    case 'number': {
      let v = 1;
      if (typeof s.minimum === 'number' && v < s.minimum) v = s.minimum;
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) v = s.exclusiveMinimum + 1;
      if (typeof s.maximum === 'number' && v > s.maximum) v = s.maximum;
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
      return { ok: true, value: v, placeholder: true };
    }
    case 'boolean':
      return { ok: true, value: true, placeholder: true };
    default:
      return FAIL;
  }
}

/** A flattened view of an object schema's properties, following refs and allOf. */
export function objectProperties(doc: Json, schema: Json, depth = 0): Record<string, Json> {
  const s = deref(doc, schema);
  if (!s || typeof s !== 'object' || depth > 4) return {};
  let out: Record<string, Json> = {};
  for (const part of Array.isArray(s.allOf) ? s.allOf : []) out = { ...out, ...objectProperties(doc, part, depth + 1) };
  return { ...out, ...(s.properties ?? {}) };
}

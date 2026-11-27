// Reads structure out of the spec: resources and their lifecycle operations, values that can be
// sent to an operation, and where identifiers appear in responses. Pure.

import { deref, successResponse, type Json, type Operation, type SpecModel } from './spec.ts';
import { isControlledHeader, objectProperties, synthesize, validateSampleValues, type SampleValues, type SchemaChecker } from './values.ts';
import { plural, singular, slugify, words } from './text.ts';

export interface Resource {
  collectionPath: string;
  itemPath?: string;
  idParam?: string;
  /** Plural, lower-case words, for example "payment intents". */
  noun: string;
  slug: string;
  tag?: string;
  create?: Operation;
  list?: Operation;
  get?: Operation;
  update?: Operation;
  remove?: Operation;
  /** Path parameters of the collection path: identifiers of parent resources. */
  parentParams: string[];
}

const segments = (path: string) => path.split('/').filter(Boolean);
const isParam = (seg: string | undefined) => !!seg && /^\{.+\}$/.test(seg);
const VERSION_SEGMENT = /^(api|rest|v\d+([._]\d+)*)$/i;

export function findResources(model: SpecModel): Resource[] {
  const byPath = new Map<string, Operation[]>();
  for (const op of model.operations) {
    if (op.deprecated) continue;
    if (!byPath.has(op.path)) byPath.set(op.path, []);
    byPath.get(op.path)!.push(op);
  }
  const at = (path: string | undefined, ...methods: string[]) => {
    for (const m of methods) {
      const op = path === undefined ? undefined : byPath.get(path)?.find((o) => o.method === m);
      if (op) return op;
    }
    return undefined;
  };

  const collections = new Map<string, string | undefined>();
  for (const path of byPath.keys()) {
    const segs = segments(path);
    if (segs.length === 0) continue;
    if (isParam(segs.at(-1))) {
      if (segs.length < 2 || isParam(segs.at(-2))) continue;
      const parent = '/' + segs.slice(0, -1).join('/');
      if (!collections.get(parent)) collections.set(parent, path);
    } else if (!collections.has(path)) collections.set(path, undefined);
  }

  const out: Resource[] = [];
  const slugs = new Set<string>();
  for (const [collectionPath, itemPath] of collections) {
    const create = at(collectionPath, 'post');
    const list = at(collectionPath, 'get');
    const get = at(itemPath, 'get');
    const update = at(itemPath, 'patch', 'put');
    const remove = at(itemPath, 'delete');
    if (!create && !get && !update && !remove) continue;
    const segs = segments(collectionPath);
    const named = segs.filter((s) => !isParam(s));
    while (named.length > 1 && VERSION_SEGMENT.test(named[0]!)) named.shift();
    const last = segs.at(-1)!;
    let slug = slugify(named.join('-')) || 'resource';
    for (let n = 2; slugs.has(slug); n++) slug = `${slugify(named.join('-')) || 'resource'}-${n}`;
    slugs.add(slug);
    out.push({
      collectionPath,
      itemPath,
      idParam: itemPath ? segments(itemPath).at(-1)!.slice(1, -1) : undefined,
      noun: plural(words(last)),
      slug,
      tag: (create ?? get ?? list ?? update ?? remove)?.tags[0],
      create,
      list,
      get,
      update,
      remove,
      parentParams: segs.filter(isParam).map((s) => s.slice(1, -1)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Values for a call

export interface BuiltValues {
  ok: boolean;
  reason?: string;
  values: SampleValues;
  /** Set when the body is exactly a named example and nothing else needs to be sent. */
  exampleName?: string;
  /** True when some value was invented from its type alone. */
  placeholder: boolean;
}

export function explicitExample(doc: Json, p: { example?: Json; examples: Record<string, Json>; schema?: Json }): Json {
  if (p.example !== undefined) return p.example;
  const named = Object.values(p.examples);
  if (named.length) return named[0];
  const s = deref(doc, p.schema);
  if (s?.example !== undefined) return s.example;
  if (Array.isArray(s?.examples) && s.examples.length) return s.examples[0];
  if (s?.default !== undefined && s.default !== null) return s.default;
  if (Array.isArray(s?.enum) && s.enum.length) return s.enum[0];
  return undefined;
}

const usesBraces = (v: Json) => JSON.stringify(v ?? null).includes('{{');

/**
 * Works out what to send to an operation. `bind` maps path or query parameter names to variable
 * references such as `{{pet_id}}`. Fails rather than guessing an identifier.
 */
export function buildValues(model: SpecModel, checker: SchemaChecker, op: Operation, bind: Record<string, string> = {}, extraQuery: Record<string, Json> = {}): BuiltValues {
  const values: SampleValues = {};
  let placeholder = false;
  const fail = (reason: string): BuiltValues => ({ ok: false, reason, values: {}, placeholder });

  for (const p of op.parameters) {
    if (p.in === 'cookie') continue;
    // The portal sets these itself; a sample that sends one is invalid.
    if ((p.in === 'header' && (isControlledHeader(p.name) || checker.credentialNames.headers.has(p.name.toLowerCase()))) || (p.in === 'query' && checker.credentialNames.query.has(p.name))) continue;
    const group = p.in === 'path' ? 'path' : p.in === 'query' ? 'query' : 'headers';
    let v: Json;
    if (p.in !== 'header' && bind[p.name] !== undefined) v = bind[p.name];
    else if (p.in === 'query' && p.name in extraQuery) v = extraQuery[p.name];
    else if (p.in === 'header' && /idempotency/i.test(p.name)) v = '{{idempotency_key}}';
    else if (!p.required) continue;
    else {
      v = explicitExample(model.doc, p);
      if (v === undefined) {
        if (p.in === 'path') return fail(`no example value for path parameter '${p.name}'`);
        const s = synthesize(model.doc, p.schema);
        if (!s.ok) return fail(`could not build a value for ${p.in} parameter '${p.name}'`);
        v = s.value;
        placeholder ||= s.placeholder;
      }
      if (usesBraces(v)) return fail(`the example for parameter '${p.name}' contains '{{'`);
    }
    (values[group] ??= {})[p.name] = v;
  }

  let exampleName: string | undefined;
  const finish = (): BuiltValues => {
    const problems = validateSampleValues(op, values, checker);
    return problems.length ? fail(problems[0]!) : { ok: true, values, exampleName, placeholder };
  };
  const rb = op.requestBody;
  if (rb && (rb.required || rb.schema)) {
    if (!/json|x-www-form-urlencoded/i.test(rb.contentType)) return fail(`request body is '${rb.contentType}', which a sample cannot carry`);
    const candidates: { name?: string; value: Json; placeholder: boolean }[] = [];
    for (const [name, value] of Object.entries(rb.examples)) candidates.push({ name, value, placeholder: false });
    if (rb.example !== undefined) candidates.push({ value: rb.example, placeholder: false });
    const s = synthesize(model.doc, rb.schema);
    const empty = s.ok && s.value && typeof s.value === 'object' && Object.keys(s.value).length === 0;
    if (s.ok && !(empty && !rb.required)) candidates.push({ value: s.value, placeholder: s.placeholder });
    if (candidates.length === 0 && !rb.required) return finish();
    const good = candidates.find((c) => !usesBraces(c.value) && validateSampleValues(op, { ...values, body: c.value }, checker).length === 0);
    if (!good) return fail(candidates.length ? 'no example or generated request body passes the request schema' : 'could not build a request body from the schema');
    values.body = good.value;
    placeholder ||= good.placeholder;
    // A key in the body is generated for the reader, as one in a header is.
    const keyField = idempotencyBodyField(model, op);
    if (keyField && values.body && typeof values.body === 'object' && !Array.isArray(values.body)) {
      const withKey = { ...values.body, [keyField]: '{{idempotency_key}}' };
      if (validateSampleValues(op, { ...values, body: withKey }, checker).length === 0) {
        values.body = withKey;
        good.name = undefined;
      }
    }
    if (good.name && /^[A-Za-z0-9_.\-]+$/.test(good.name) && !values.path && !values.query && !values.headers) exampleName = good.name;
  }

  return finish();
}

// ---------------------------------------------------------------------------------------------
// Identifiers in responses

function idCandidates(idParam: string): string[] {
  const out = [idParam, 'id'];
  const snake = idParam.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (snake !== idParam) out.push(snake);
  return [...new Set(out)];
}

const isScalar = (doc: Json, schema: Json) => {
  const s = deref(doc, schema);
  const t = Array.isArray(s?.type) ? s.type.find((x: string) => x !== 'null') : s?.type;
  return t === 'string' || t === 'integer' || t === 'number';
};

/** JSONPath of the identifier in an object schema, looking one wrapper level down if needed. */
function idInObject(doc: Json, schema: Json, idParam: string): string | undefined {
  const props = objectProperties(doc, schema);
  for (const c of idCandidates(idParam)) if (props[c] && isScalar(doc, props[c])) return `$.${c}`;
  for (const [wrap, inner] of Object.entries(props)) {
    const s = deref(doc, inner);
    if (!s || s.type === 'array' || s.items) continue;
    const innerProps = objectProperties(doc, inner);
    for (const c of idCandidates(idParam)) if (innerProps[c] && isScalar(doc, innerProps[c]) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(wrap)) return `$.${wrap}.${c}`;
  }
  return undefined;
}

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where the new resource's identifier is in the response of a create call. */
export function idPathInResponse(model: SpecModel, op: Operation, idParam: string): string | undefined {
  const schema = successResponse(op)?.schema;
  if (!schema) return undefined;
  const path = idInObject(model.doc, schema, idParam);
  return path && path.split('.').slice(1).every((k) => SAFE_KEY.test(k)) ? path : undefined;
}

/** Where the first item's identifier is in the response of a list call. */
export function firstIdPathInList(model: SpecModel, op: Operation, idParam: string): string | undefined {
  const schema = successResponse(op)?.schema;
  const s = deref(model.doc, schema);
  if (!s) return undefined;
  const inItems = (items: Json) => {
    const props = objectProperties(model.doc, items);
    return idCandidates(idParam).find((c) => props[c] && isScalar(model.doc, props[c]) && SAFE_KEY.test(c));
  };
  if (s.type === 'array' || s.items) {
    const c = inItems(s.items);
    return c ? `$[0].${c}` : undefined;
  }
  for (const [name, raw] of Object.entries(objectProperties(model.doc, schema))) {
    const p = deref(model.doc, raw);
    if (p && (p.type === 'array' || p.items) && SAFE_KEY.test(name)) {
      const c = inItems(p.items);
      if (c) return `$.${name}[0].${c}`;
    }
  }
  return undefined;
}

/** A variable name for a resource identifier, for example `pet_id`. */
export function idVariable(resource: Resource): string {
  let name = (resource.idParam ?? 'id').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (name === 'id' || name === '') {
    const noun = resource.noun.split(' ').at(-1)!.replace(/[^a-z0-9]/g, '');
    name = `${noun.length > 3 ? noun.replace(/s$/, '') : noun}_id`;
  } else if (!/(^|_)id$/.test(name)) name += '_id';
  return /^[a-z]/.test(name) ? name : `r_${name}`;
}

// ---------------------------------------------------------------------------------------------
// Identifiers in request bodies

/** A record that must exist before a call, because the call's body refers to it by identifier. */
export interface Prerequisite {
  resource: Resource;
  /** The operation that creates the record. */
  op: Operation;
  built: BuiltValues;
  variable: string;
  /** JSONPath of the identifier in the response of `op`. */
  idPath: string;
  /** The body field that refers to the record, for example `customer_id`. */
  field: string;
  neededBy: Operation;
}

export interface PrereqState {
  /** In the order the calls must be made. */
  steps: Prerequisite[];
  /** Identifier fields left with an example value, because nothing in the spec creates them. */
  unresolved: Set<string>;
  /** Normalized field name to the variable reference that replaces it. */
  vars: Map<string, string>;
  /** Variable names already in use on the page. */
  reserved: Set<string>;
}

export const newPrereqState = (reserved: string[] = []): PrereqState => ({
  steps: [],
  unresolved: new Set(),
  vars: new Map(),
  reserved: new Set(['base_url', 'api_key', 'idempotency_key', 'api_name', ...reserved]),
});

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const MAX_PREREQ_STEPS = 5;
const MAX_PREREQ_DEPTH = 2;

/**
 * The top-level resource a body field such as `customer_id` names: one whose item path takes a
 * parameter of the same name and which can be created. When several qualify, the one whose noun
 * matches the field wins; otherwise the field is left alone rather than guessed.
 */
function creatorOf(resources: Resource[], key: string, exclude: Set<Resource>): Resource | undefined {
  const cands = resources.filter((r) => r.parentParams.length === 0 && r.itemPath && r.idParam && snake(r.idParam) === key && r.create && /^[A-Za-z0-9_.\-/:~@$]+$/.test(r.create.id));
  if (cands.some((r) => exclude.has(r))) return undefined;
  const stem = key.replace(/_id$/, '');
  const named = cands.filter((r) => singular(r.noun).replace(/[^a-z0-9]+/g, '_') === stem);
  return named[0] ?? (cands.length === 1 ? cands[0] : undefined);
}

/**
 * Replaces example identifiers in a request body with variables. An identifier in `available` is
 * already known on the page. Any other is matched to a resource the spec can create; that create
 * call is added to `state.steps`, after whatever its own body needs. Fields that match nothing
 * keep their example value and are recorded as unresolved.
 */
export function bindBodyIds(
  model: SpecModel,
  checker: SchemaChecker,
  resources: Resource[],
  op: Operation,
  built: BuiltValues,
  state: PrereqState,
  opts: { exclude?: Resource[]; available?: Record<string, string>; depth?: number } = {},
): BuiltValues {
  const body = built.values.body;
  if (!built.ok || !body || typeof body !== 'object') return built;
  const exclude = new Set(opts.exclude ?? []);
  const depth = opts.depth ?? 0;
  const available = new Map(Object.entries(opts.available ?? {}).map(([k, v]) => [snake(k), v]));
  const saved = { steps: state.steps.length, vars: new Map(state.vars), unresolved: new Set(state.unresolved), reserved: new Set(state.reserved) };

  const resolve = (key: string): string | undefined => {
    if (available.has(key)) return available.get(key);
    if (state.vars.has(key)) return state.vars.get(key);
    const r = creatorOf(resources, key, exclude);
    if (!r || depth >= MAX_PREREQ_DEPTH || state.steps.length >= MAX_PREREQ_STEPS) return undefined;
    const variable = idVariable(r);
    const idPath = idPathInResponse(model, r.create!, r.idParam!);
    let made = buildValues(model, checker, r.create!);
    if (!made.ok || !idPath || state.reserved.has(variable)) return undefined;
    made = bindBodyIds(model, checker, resources, r.create!, made, state, { exclude: [...exclude, r], depth: depth + 1 });
    state.reserved.add(variable);
    state.vars.set(key, `{{${variable}}}`);
    state.steps.push({ resource: r, op: r.create!, built: made, variable, idPath, field: key, neededBy: op });
    return state.vars.get(key);
  };

  let changed = false;
  const missing: string[] = [];
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && v !== '' && !v.includes('{{') && /_id$/.test(snake(k))) {
        const ref = resolve(snake(k));
        if (ref) changed = true;
        else missing.push(k);
        out[k] = ref ?? v;
      } else out[k] = walk(v);
    }
    return out;
  };
  const bound = walk(body);
  // Only a field that names a path parameter somewhere in the spec is known to identify a record.
  const known = new Set(model.operations.flatMap((o) => o.parameters.filter((x) => x.in === 'path').map((x) => snake(x.name))));
  for (const k of missing) if (known.has(snake(k))) state.unresolved.add(k);
  if (!changed) return built;
  if (validateSampleValues(op, { ...built.values, body: bound }, checker).length) {
    // The body does not validate with variables in it: keep the examples and take back the steps.
    state.steps.length = saved.steps;
    state.vars = saved.vars;
    state.reserved = saved.reserved;
    state.unresolved = saved.unresolved;
    for (const k of missing) if (known.has(snake(k))) state.unresolved.add(k);
    return built;
  }
  return { ...built, values: { ...built.values, body: bound }, exampleName: undefined };
}

// ---------------------------------------------------------------------------------------------
// Cross-cutting features

const CURSOR_PARAMS = /^(cursor|after|before|starting_after|ending_before|page_?token|next_?token|next_?cursor|continuation(_?token)?|marker)$/i;
const OFFSET_PARAMS = /^(offset|skip|start)$/i;
const PAGE_PARAMS = /^(page|page_?(number|num|index))$/i;
const SIZE_PARAMS = /^(limit|per_?page|page_?size|size|count|max_?results|top)$/i;
const NEXT_FIELDS = /^(next_?cursor|next_?page_?token|next_?token|next|cursor|has_?more|next_?page|continuation(_?token)?)$/i;

export interface PaginationInfo {
  style: 'cursor' | 'offset' | 'page';
  operations: Operation[];
  /** Parameter name to the first description found for it. */
  params: Map<string, string | undefined>;
  example?: { op: Operation; sizeParam?: string; cursorParam?: string; nextField?: string };
  responseFields: Map<string, string | undefined>;
}

export function findPagination(model: SpecModel): PaginationInfo | undefined {
  const styles = { cursor: [] as Operation[], offset: [] as Operation[], page: [] as Operation[] };
  const styleOf = (op: Operation) => {
    const q = op.parameters.filter((p) => p.in === 'query').map((p) => p.name);
    if (q.some((n) => CURSOR_PARAMS.test(n))) return 'cursor';
    if (q.some((n) => OFFSET_PARAMS.test(n)) && q.some((n) => SIZE_PARAMS.test(n))) return 'offset';
    if (q.some((n) => PAGE_PARAMS.test(n))) return 'page';
    return undefined;
  };
  for (const op of model.operations) {
    if (op.method !== 'get' || op.deprecated) continue;
    const s = styleOf(op);
    if (s) styles[s].push(op);
  }
  const style = (Object.keys(styles) as (keyof typeof styles)[]).sort((a, b) => styles[b].length - styles[a].length)[0]!;
  const operations = styles[style];
  if (operations.length === 0) return undefined;

  const params = new Map<string, string | undefined>();
  const responseFields = new Map<string, string | undefined>();
  const relevant = (n: string) => CURSOR_PARAMS.test(n) || OFFSET_PARAMS.test(n) || PAGE_PARAMS.test(n) || SIZE_PARAMS.test(n);
  for (const op of operations) {
    for (const p of op.parameters) {
      if (p.in === 'query' && relevant(p.name) && !params.get(p.name)) params.set(p.name, p.description);
    }
    for (const [name, raw] of Object.entries(objectProperties(model.doc, successResponse(op)?.schema))) {
      if (NEXT_FIELDS.test(name) && !responseFields.get(name)) responseFields.set(name, deref(model.doc, raw)?.description);
    }
  }
  const pick = operations.find((op) => op.parameters.every((p) => p.in !== 'path')) ?? operations[0]!;
  const q = pick.parameters.filter((p) => p.in === 'query');
  const cursorParam = q.find((p) => CURSOR_PARAMS.test(p.name) && !/^(before|ending_before)$/i.test(p.name))?.name;
  const props = objectProperties(model.doc, successResponse(pick)?.schema);
  const nextField = Object.keys(props).find((n) => /cursor|token|^next$/i.test(n) && NEXT_FIELDS.test(n) && isScalar(model.doc, props[n]) && SAFE_KEY.test(n));
  return {
    style,
    operations,
    params,
    responseFields,
    example: { op: pick, sizeParam: q.find((p) => SIZE_PARAMS.test(p.name))?.name, cursorParam, nextField },
  };
}

export interface ErrorInfo {
  statuses: { status: string; description?: string; count: number }[];
  schemaName?: string;
  schemaShare: number;
}

export function findErrors(model: SpecModel): ErrorInfo | undefined {
  const byStatus = new Map<string, { count: number; descriptions: Map<string, number> }>();
  const schemas = new Map<string, number>();
  let responses = 0;
  for (const op of model.operations) {
    for (const r of op.responses) {
      if (!/^([45]\d\d|[45]XX|default)$/i.test(r.status)) continue;
      responses++;
      const e = byStatus.get(r.status) ?? { count: 0, descriptions: new Map() };
      e.count++;
      if (r.description) e.descriptions.set(r.description, (e.descriptions.get(r.description) ?? 0) + 1);
      byStatus.set(r.status, e);
      const ref = typeof r.schema?.$ref === 'string' ? /^#\/components\/schemas\/([^/]+)$/.exec(r.schema.$ref)?.[1] : undefined;
      if (ref) schemas.set(ref, (schemas.get(ref) ?? 0) + 1);
    }
  }
  if (byStatus.size === 0) return undefined;
  const top = [...schemas].sort((a, b) => b[1] - a[1])[0];
  const order = (s: string) => (/^\d+$/.test(s) ? Number(s) : /XX$/i.test(s) ? Number(s[0]) * 100 + 99.5 : 1000);
  return {
    statuses: [...byStatus]
      .map(([status, e]) => ({ status, count: e.count, description: [...e.descriptions].sort((a, b) => b[1] - a[1])[0]?.[0] }))
      .sort((a, b) => order(a.status) - order(b.status)),
    schemaName: top?.[0],
    schemaShare: top ? top[1] / responses : 0,
  };
}

export interface RateLimitInfo {
  operations: Operation[];
  description?: string;
  headers: Map<string, string | undefined>;
}

export function findRateLimits(model: SpecModel): RateLimitInfo | undefined {
  const operations: Operation[] = [];
  const headers = new Map<string, string | undefined>();
  let description: string | undefined;
  for (const op of model.operations) {
    let hit = false;
    for (const r of op.responses) {
      if (r.status === '429') {
        hit = true;
        description ??= r.description;
      }
      for (const [h, info] of Object.entries(r.headers)) {
        if (/rate-?limit|retry-after/i.test(h)) {
          hit = true;
          if (!headers.get(h)) headers.set(h, info.description);
        }
      }
    }
    if (hit) operations.push(op);
  }
  return operations.length ? { operations, description, headers } : undefined;
}

/** The top-level request body property that carries an idempotency key, if the body has one. */
export function idempotencyBodyField(model: SpecModel, op: Operation): string | undefined {
  const rb = op.requestBody;
  if (!rb?.schema || !/json|x-www-form-urlencoded/i.test(rb.contentType)) return undefined;
  return Object.keys(objectProperties(model.doc, rb.schema)).find((k) => /idempotency/i.test(k) && isScalar(model.doc, objectProperties(model.doc, rb.schema)[k]));
}

export interface IdempotencyInfo {
  /** Where the key goes in most operations that take one. */
  where: 'header' | 'body';
  /** The header or body field name. */
  name: string;
  description?: string;
  operations: Operation[];
}

export function findIdempotency(model: SpecModel): IdempotencyInfo | undefined {
  const found = { header: [] as [Operation, string, string | undefined][], body: [] as [Operation, string, string | undefined][] };
  for (const op of model.operations) {
    if (op.deprecated) continue;
    const p = op.parameters.find((x) => x.in === 'header' && /idempotency/i.test(x.name));
    if (p) {
      found.header.push([op, p.name, p.description]);
      continue;
    }
    const field = idempotencyBodyField(model, op);
    if (field) found.body.push([op, field, deref(model.doc, objectProperties(model.doc, op.requestBody!.schema)[field])?.description]);
  }
  const where = found.header.length >= found.body.length ? 'header' : 'body';
  const list = found[where];
  if (list.length === 0) return undefined;
  return { where, name: list[0]![1], description: list.find(([, , d]) => d)?.[2], operations: list.map(([op]) => op) };
}

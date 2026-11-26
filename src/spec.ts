// Loads an OpenAPI 3.x document and normalizes it into the model the generators and validator use.
// Pure: takes text, returns data. No file or network access.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export class SpecError extends Error {}

export type Json = any;

export interface SpecIssue {
  code: string;
  message: string;
  subject?: string;
}

export interface Param {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema?: Json;
  example?: Json;
  examples: Record<string, Json>;
}

export interface RequestBody {
  required: boolean;
  contentType: string;
  schema?: Json;
  example?: Json;
  /** Named examples, by name, already resolved to their values. */
  examples: Record<string, Json>;
}

export interface ResponseInfo {
  status: string;
  description?: string;
  contentType?: string;
  schema?: Json;
  hasExample: boolean;
  headers: Record<string, { description?: string }>;
}

export interface Operation {
  id: string;
  /** True when the spec had no operationId and the id was derived from method and path. */
  derivedId: boolean;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: Param[];
  requestBody?: RequestBody;
  responses: ResponseInfo[];
  /** Effective security requirements. Empty array means the operation is public. */
  security: Record<string, string[]>[];
  hasCallbacks: boolean;
}

export interface Webhook {
  name: string;
  method: string;
  summary?: string;
  description?: string;
  schemaName?: string;
}

export interface SpecModel {
  doc: Json;
  sha256: string;
  openapi: string;
  title: string;
  version: string;
  description?: string;
  servers: { url: string; description?: string }[];
  tags: { name: string; description?: string }[];
  operations: Operation[];
  operationsById: Map<string, Operation>;
  schemaNames: Set<string>;
  securitySchemes: Record<string, Json>;
  webhooks: Webhook[];
  issues: SpecIssue[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** The portal's rule for a missing operationId: `{method}_{path}`, non-alphanumerics become `_`. */
export function deriveOperationId(method: string, path: string): string {
  return method.toLowerCase() + path.replace(/[^A-Za-z0-9]/g, '_');
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Follows local `$ref`s. Returns undefined for external or dangling references. */
export function deref(doc: Json, node: Json, issues?: SpecIssue[]): Json {
  const seen = new Set<string>();
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) {
      issues?.push({ code: 'unresolved-ref', message: `Reference '${ref}' is external or circular and was not followed.` });
      return undefined;
    }
    seen.add(ref);
    let cur: Json = doc;
    for (const raw of ref.slice(2).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      cur = cur && typeof cur === 'object' ? cur[key] : undefined;
    }
    if (cur === undefined) {
      issues?.push({ code: 'unresolved-ref', message: `Reference '${ref}' does not resolve.` });
      return undefined;
    }
    node = cur;
  }
  return node;
}

/** Name of the component schema a `$ref` points to, if it is one. */
export function schemaRefName(schema: Json): string | undefined {
  const m = typeof schema?.$ref === 'string' && /^#\/components\/schemas\/([^/]+)$/.exec(schema.$ref);
  return m ? m[1] : undefined;
}

function isJsonType(ct: string): boolean {
  return /^application\/(.+\+)?json\b/i.test(ct);
}

function pickContent(content: Json): [string, Json] | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const keys = Object.keys(content);
  const key = keys.find(isJsonType) ?? keys[0];
  return key ? [key, content[key]] : undefined;
}

function namedExamples(doc: Json, examples: Json): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (examples && typeof examples === 'object' && !Array.isArray(examples)) {
    for (const [name, ex] of Object.entries(examples)) {
      const r = deref(doc, ex);
      if (r && typeof r === 'object' && 'value' in r) out[name] = r.value;
    }
  }
  return out;
}

export function loadSpec(source: string | Uint8Array): SpecModel {
  const text = typeof source === 'string' ? source : new TextDecoder('utf-8').decode(source);
  let doc: Json;
  try {
    doc = text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 1000 });
  } catch (e) {
    throw new SpecError(`The specification could not be parsed: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') throw new SpecError('The specification is not an object.');
  const openapi = String(doc.openapi ?? '');
  if (!/^3\.[0-9]+(\.|$)/.test(openapi)) {
    throw new SpecError(
      doc.swagger
        ? `This is a Swagger ${doc.swagger} document. Only OpenAPI 3.x is supported; convert it first.`
        : `Unsupported or missing 'openapi' version: '${openapi}'. Only OpenAPI 3.x is supported.`,
    );
  }

  const issues: SpecIssue[] = [];
  if (!/^3\.[01]\./.test(openapi)) {
    issues.push({ code: 'untested-version', message: `OpenAPI ${openapi} is newer than 3.1. It was read as 3.1.` });
  }
  const operations: Operation[] = [];
  const operationsById = new Map<string, Operation>();
  const globalSecurity: Record<string, string[]>[] = Array.isArray(doc.security) ? doc.security : [];

  const buildParams = (list: Json): Param[] => {
    const out: Param[] = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const p = deref(doc, raw, issues);
      if (!p || typeof p.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(p.in)) continue;
      const content = pickContent(p.content);
      out.push({
        name: p.name,
        in: p.in,
        required: p.in === 'path' ? true : p.required === true,
        description: p.description,
        schema: p.schema ?? content?.[1]?.schema,
        example: p.example,
        examples: namedExamples(doc, p.examples),
      });
    }
    return out;
  };

  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = deref(doc, rawItem, issues);
    if (!item || typeof item !== 'object') continue;
    const shared = buildParams(item.parameters);
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const derivedId = typeof op.operationId !== 'string' || op.operationId === '';
      const id = derivedId ? deriveOperationId(method, path) : op.operationId;
      const label = `${method.toUpperCase()} ${path}`;
      if (derivedId) issues.push({ code: 'missing-operation-id', subject: label, message: `${label} has no operationId. Using '${id}'.` });

      const own = buildParams(op.parameters);
      const parameters = [...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)), ...own];

      let requestBody: RequestBody | undefined;
      const rb = deref(doc, op.requestBody, issues);
      const rbContent = pickContent(rb?.content);
      if (rb && rbContent) {
        requestBody = {
          required: rb.required === true,
          contentType: rbContent[0],
          schema: rbContent[1]?.schema,
          example: rbContent[1]?.example,
          examples: namedExamples(doc, rbContent[1]?.examples),
        };
      }

      const responses: ResponseInfo[] = [];
      for (const [status, rawResp] of Object.entries(op.responses ?? {})) {
        const resp = deref(doc, rawResp, issues);
        if (!resp) continue;
        const c = pickContent(resp.content);
        const headers: Record<string, { description?: string }> = {};
        for (const [h, rawH] of Object.entries(resp.headers ?? {})) headers[h] = { description: deref(doc, rawH)?.description };
        const schema = c?.[1]?.schema;
        responses.push({
          status: String(status),
          description: resp.description,
          contentType: c?.[0],
          schema,
          hasExample: !!c && (c[1]?.example !== undefined || !!c[1]?.examples || deref(doc, schema)?.example !== undefined),
          headers,
        });
      }

      const operation: Operation = {
        id,
        derivedId,
        method,
        path,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        description: typeof op.description === 'string' ? op.description : undefined,
        tags: Array.isArray(op.tags) ? op.tags.filter((t: Json) => typeof t === 'string') : [],
        deprecated: op.deprecated === true,
        parameters,
        requestBody,
        responses,
        security: Array.isArray(op.security) ? op.security : globalSecurity,
        hasCallbacks: !!op.callbacks && Object.keys(op.callbacks).length > 0,
      };
      if (operationsById.has(id)) {
        issues.push({ code: 'duplicate-operation-id', subject: label, message: `operationId '${id}' is used more than once. ${label} was ignored.` });
        continue;
      }
      operationsById.set(id, operation);
      operations.push(operation);
    }
  }

  const webhooks: Webhook[] = [];
  for (const [name, rawItem] of Object.entries(doc.webhooks ?? doc['x-webhooks'] ?? {})) {
    const item = deref(doc, rawItem, issues);
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const body = pickContent(deref(doc, op.requestBody)?.content);
      webhooks.push({ name, method, summary: op.summary, description: op.description, schemaName: schemaRefName(body?.[1]?.schema) });
    }
  }

  const info = doc.info ?? {};
  return {
    doc,
    sha256: sha256(source),
    openapi,
    title: typeof info.title === 'string' && info.title ? info.title : 'API',
    version: info.version === undefined ? '' : String(info.version),
    description: typeof info.description === 'string' ? info.description : undefined,
    servers: (Array.isArray(doc.servers) ? doc.servers : []).filter((s: Json) => typeof s?.url === 'string'),
    tags: (Array.isArray(doc.tags) ? doc.tags : []).filter((t: Json) => typeof t?.name === 'string'),
    operations,
    operationsById,
    schemaNames: new Set(Object.keys(doc.components?.schemas ?? {})),
    securitySchemes: Object.fromEntries(
      Object.entries(doc.components?.securitySchemes ?? {}).map(([k, v]) => [k, deref(doc, v) ?? {}]),
    ),
    webhooks,
    issues,
  };
}

/** First 2xx response, preferring one with a body. */
export function successResponse(op: Operation): ResponseInfo | undefined {
  const ok = op.responses.filter((r) => /^2\d\d$/.test(r.status)).sort((a, b) => a.status.localeCompare(b.status));
  return ok.find((r) => r.schema) ?? ok[0];
}

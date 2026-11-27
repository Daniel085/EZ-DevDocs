// Page generators. Each takes the spec model and returns a page, or the reason it was skipped.
// Nothing here writes API request code: calls are always <Sample> components.

import {
  bindBodyIds,
  buildValues,
  findErrors,
  findIdempotency,
  findPagination,
  findRateLimits,
  firstIdPathInList,
  idPathInResponse,
  idVariable,
  newPrereqState,
  type BuiltValues,
  type Prerequisite,
  type PrereqState,
  type Resource,
} from './analyze.ts';
import { deref, schemaRefName, successResponse, type Json, type Operation, type SpecModel } from './spec.ts';
import { attr, capitalize, code, frontmatter, meta, plainText, prose, singular } from './text.ts';

export { singular };
import type { SchemaChecker } from './values.ts';

export type PageType = 'quickstart' | 'concept' | 'how-to' | 'tutorial';

export interface Page {
  slug: string;
  title: string;
  description: string;
  type: PageType;
  operations: string[];
  body: string;
  /** Things the spec did not say, which a human should complete. */
  gaps: string[];
  /** Operations whose sample values were invented from types alone. */
  placeholders: string[];
}

export interface Skipped {
  page: string;
  reason: string;
}

export interface Ctx {
  model: SpecModel;
  checker: SchemaChecker;
  resources: Resource[];
  /** Whether another page will exist in the bundle, so links to it are safe. */
  has: (slug: string) => boolean;
}

export type Result = Page | Skipped;
export const isPage = (r: Result): r is Page => 'body' in r;

// ---------------------------------------------------------------------------------------------
// Building blocks

/** An identifier can be written into a component attribute and a link target. */
const usableId = (id: string) => /^[A-Za-z0-9_.\-/:~@$]+$/.test(id);
const usableSchema = (name: string) => /^[A-Za-z0-9_.\-]+$/.test(name);

const opLink = (op: Operation) => (usableId(op.id) ? `[${code(op.id)}](op:${op.id})` : code(op.id));
const schemaLink = (name: string) => (usableSchema(name) ? `[${code(name)}](schema:${name})` : code(name));
const article = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

class Doc {
  lines: string[] = [];
  operations = new Set<string>();
  gaps: string[] = [];
  placeholders: string[] = [];

  /** Adds blocks, separated by blank lines. Empty blocks are dropped. */
  add(...blocks: (string | undefined | false)[]): this {
    for (const b of blocks) if (b) this.lines.push(b, '');
    return this;
  }

  sample(op: Operation, built: BuiltValues, opts: { title?: string; capture?: [string, string] } = {}): this {
    this.operations.add(op.id);
    if (built.placeholder) this.placeholders.push(op.id);
    let attrs = `operation="${op.id}"`;
    if (built.exampleName) attrs += ` example="${built.exampleName}"`;
    if (opts.title) attrs += ` title="${attr(opts.title)}"`;
    if (opts.capture) attrs += ` capture="${opts.capture[0]}=${opts.capture[1]}"`;
    const v = built.values;
    const inline = !built.exampleName && (v.path || v.query || v.headers || v.body !== undefined);
    if (!inline) return this.add(`<Sample ${attrs} />`);
    const values: Json = {};
    for (const k of ['path', 'query', 'headers'] as const) if (v[k]) values[k] = v[k];
    if (v.body !== undefined) values.body = v.body;
    return this.add(`<Sample ${attrs}>\n\`\`\`json\n${JSON.stringify(values, null, 2)}\n\`\`\`\n</Sample>`);
  }

  /** The documented success response, with a link to its schema when it has a name. */
  response(model: SpecModel, op: Operation): this {
    const r = successResponse(op);
    if (!r) {
      this.gaps.push(`${op.id} documents no success response.`);
      return this;
    }
    const desc = prose(r.description, 200);
    this.add(`A successful call returns ${code(r.status)}${desc ? `: ${desc.replace(/[.\s]+$/, '')}.` : '.'}`);
    if (r.schema) {
      this.add(`<Response operation="${op.id}" status="${r.status}" />`);
      const s = deref(model.doc, r.schema);
      const name = schemaRefName(r.schema);
      const itemName = schemaRefName(s?.items);
      if (name && usableSchema(name)) this.add(`The body is described by the ${schemaLink(name)} schema.`);
      else if (itemName && usableSchema(itemName)) this.add(`The body is a list. Each item is described by the ${schemaLink(itemName)} schema.`);
    }
    return this;
  }

  finish(slug: string, type: PageType, title: string, description: string): Page {
    const operations = [...this.operations];
    const head = frontmatter({ title, description, type, operations });
    return {
      slug,
      type,
      title,
      description,
      operations,
      body: head + '\n' + this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
      gaps: this.gaps,
      placeholders: this.placeholders,
    };
  }
}

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => c || ' ').join(' | ')} |`)].join('\n');

function opList(ops: Operation[], max = 12): string {
  const shown = ops.slice(0, max).map((op) => `- ${opLink(op)}${op.summary ? `: ${prose(op.summary, 120)}` : ''}`);
  if (ops.length > max) shown.push(`- and ${ops.length - max} more`);
  return shown.join('\n');
}

const opIntro = (op: Operation) => {
  const summary = prose(op.summary, 160).replace(/[.\s]+$/, '');
  // A flow step keeps the operation's rules, which specs often put late in the description.
  const desc = prose(op.description, 1200);
  const same = (x?: string) => plainText(x).toLowerCase().replace(/s\b|[^a-z0-9]/g, '');
  return [`Call ${opLink(op)}${summary ? `: ${summary}.` : '.'}`, desc && same(op.description) !== same(op.summary) ? desc : ''].filter(Boolean).join('\n\n');
};

// ---------------------------------------------------------------------------------------------
// Authentication

interface SchemeText {
  label: string;
  /** Completes "authenticates requests with …". */
  noun: string;
  how: string;
}

function describeScheme(name: string, s: Json): SchemeText {
  const type = String(s?.type ?? '');
  if (type === 'apiKey') return { label: 'API key', noun: 'an API key', how: `Send your API key in the ${code(String(s.name ?? ''))} ${s.in === 'query' ? 'query parameter' : s.in === 'cookie' ? 'cookie' : 'header'} with every request.` };
  if (type === 'http') {
    const scheme = String(s.scheme ?? '').toLowerCase();
    if (scheme === 'bearer') return { label: 'Bearer token', noun: 'a bearer token', how: `Send your token in the ${code('Authorization')} header, using the ${code('Bearer')} scheme${s.bearerFormat ? ` (${prose(String(s.bearerFormat))})` : ''}.` };
    if (scheme === 'basic') return { label: 'HTTP Basic', noun: 'HTTP Basic credentials', how: `Send your credentials in the ${code('Authorization')} header, using HTTP Basic authentication.` };
    return { label: `HTTP ${prose(scheme)}`, noun: `HTTP ${prose(scheme)} credentials`, how: `Send your credentials in the ${code('Authorization')} header, using the ${code(scheme)} scheme.` };
  }
  if (type === 'oauth2') return { label: 'OAuth 2.0', noun: 'OAuth 2.0', how: `Get an access token through OAuth 2.0 and send it in the ${code('Authorization')} header, using the ${code('Bearer')} scheme.` };
  if (type === 'openIdConnect') return { label: 'OpenID Connect', noun: 'OpenID Connect', how: `Get a token through OpenID Connect and send it in the ${code('Authorization')} header, using the ${code('Bearer')} scheme.` };
  if (type === 'mutualTLS') return { label: 'Mutual TLS', noun: 'a client certificate', how: 'Present a client certificate when you connect.' };
  return { label: prose(name), noun: `the ${prose(name)} scheme`, how: '' };
}

function usedSchemes(model: SpecModel): string[] {
  const used = new Set<string>();
  for (const op of model.operations) for (const req of op.security) for (const k of Object.keys(req ?? {})) used.add(k);
  const declared = Object.keys(model.securitySchemes);
  return declared.filter((k) => used.has(k)).concat(declared.filter((k) => !used.has(k)));
}

export function authenticationPage(ctx: Ctx): Result {
  const { model } = ctx;
  const names = usedSchemes(model);
  if (names.length === 0) return { page: 'authentication', reason: 'the spec declares no security schemes' };
  const d = new Doc();
  d.add(names.length === 1 ? '{{api_name}} has one way to authenticate requests.' : `{{api_name}} has ${names.length} ways to authenticate requests.`);
  let undescribed = 0;
  for (const name of names) {
    const s = model.securitySchemes[name];
    const t = describeScheme(name, s);
    d.add(`## ${t.label} (${code(name)})`, prose(s.description, 600), t.how);
    if (!s.description) undescribed++;
    if (s.type === 'oauth2' && s.flows && typeof s.flows === 'object') {
      const rows: string[][] = [];
      const scopes = new Map<string, string>();
      for (const [flow, f] of Object.entries<Json>(s.flows)) {
        rows.push([code(flow), f?.authorizationUrl ? code(String(f.authorizationUrl)) : '', f?.tokenUrl ? code(String(f.tokenUrl)) : '']);
        for (const [scope, desc] of Object.entries(f?.scopes ?? {})) if (!scopes.has(scope)) scopes.set(scope, String(desc ?? ''));
      }
      if (rows.length) d.add(table(['Flow', 'Authorization URL', 'Token URL'], rows));
      if (scopes.size) d.add('### Scopes', table(['Scope', 'Description'], [...scopes].map(([k, v]) => [code(k), prose(v, 200)])));
    }
    if (s.type === 'openIdConnect' && s.openIdConnectUrl) d.add(`The discovery document is at ${code(String(s.openIdConnectUrl))}.`);
  }
  const open = model.operations.filter((op) => op.security.length === 0 || op.security.some((r) => Object.keys(r ?? {}).length === 0));
  d.add('## Which operations need credentials');
  if (open.length === 0) d.add('Every operation requires credentials.');
  else if (open.length === model.operations.length) {
    d.add('The API description does not attach these schemes to any operation.');
    d.gaps.push('Security schemes are declared but no operation requires them. Check the `security` fields in the spec.');
  } else d.add(`${open.length} of ${model.operations.length} operations can be called without credentials, including:`, opList(open, 5));
  d.gaps.push('The spec does not say how a developer obtains credentials. Add where to get them.');
  if (undescribed) d.gaps.push(`${undescribed} security scheme(s) have no description.`);
  return d.finish('authentication', 'concept', 'Authentication', `How to authenticate requests to ${meta(model.title, 120)}.`);
}

// ---------------------------------------------------------------------------------------------
// Quickstart

const requiresCredentials = (op: Operation) => op.security.length > 0 && op.security.every((r) => Object.keys(r ?? {}).length > 0);

function firstCall(ctx: Ctx): { op: Operation; built: BuiltValues } | undefined {
  let best: { op: Operation; built: BuiltValues; score: number } | undefined;
  const secured = ctx.model.operations.some(requiresCredentials);
  for (const op of ctx.model.operations) {
    if (op.deprecated || !usableId(op.id)) continue;
    const built = buildValues(ctx.model, ctx.checker, op);
    if (!built.ok) continue;
    const ok = successResponse(op);
    let score = 0;
    if (op.method === 'get') score += 50;
    else if (op.method === 'delete') score -= 100;
    if (!op.parameters.some((p) => p.in === 'path')) score += 20;
    // When the API has credentials, the first call should show them being used.
    if (secured && !requiresCredentials(op)) score -= 40;
    if (!built.placeholder) score += 10;
    if (ok?.schema) score += 10;
    if (ok?.hasExample) score += 5;
    if (!op.parameters.some((p) => p.in === 'query' && p.required)) score += 5;
    score -= op.path.split('/').filter(Boolean).length;
    if (!best || score > best.score) best = { op, built, score };
  }
  return best;
}

export function quickstartPage(ctx: Ctx): Result {
  const { model } = ctx;
  if (model.operations.length === 0) return { page: 'quickstart', reason: 'the spec has no operations' };
  const d = new Doc();
  const call = firstCall(ctx);
  d.add('This guide takes you from nothing to a first successful call to {{api_name}}.', plainText(model.description) !== plainText(model.title) && prose(model.description, 400));
  if (model.servers.length === 0) d.gaps.push('The spec lists no servers, so the base URL is unknown.');

  // The first call's own requirement, or failing that any operation's: an API with credentials
  // never gets a quickstart that says it has none.
  const requirementOf = (op: Operation | undefined) => op?.security.find((r) => Object.keys(r ?? {}).length > 0);
  const requirement = requirementOf(call?.op) ?? requirementOf(model.operations.find((op) => requirementOf(op)));
  const callIsOpen = !!call && !!requirement && !requirementOf(call.op);
  const schemeName = requirement ? Object.keys(requirement)[0]! : undefined;
  const scheme = schemeName ? model.securitySchemes[schemeName] : undefined;

  d.add('<Steps>');
  if (scheme) {
    const t = describeScheme(schemeName!, scheme);
    d.add('<Step title="Get your credentials">', `{{api_name}} authenticates requests with ${t.noun}.`, prose(scheme.description, 400));
    d.add('<Callout type="note" title="Where to get credentials">', 'The API description does not say how credentials are issued. Ask the API provider if you do not have them yet.', '</Callout>');
    d.gaps.push('Quickstart step "Get your credentials": the spec does not say how credentials are issued. Replace the callout with real instructions.');
    d.add('</Step>', '<Step title="Authenticate your requests">', t.how, callIsOpen ? `${opLink(call!.op)}, the call below, is one of the operations that needs no credentials.` : 'The samples on this page include your credentials for you.');
    if (ctx.has('authentication')) d.add('For the details, see [Authentication](guide:authentication).');
    d.add('</Step>');
  } else if (requirement) {
    d.gaps.push(`Operations require the security scheme '${schemeName}', which the spec does not define.`);
  } else {
    d.gaps.push('The spec declares no authentication. If the API needs credentials, add that step to the quickstart.');
  }

  if (call) {
    d.add('<Step title="Make your first call">', opIntro(call.op), 'Requests go to {{base_url}}.');
    d.sample(call.op, call.built);
    d.add('</Step>', '<Step title="Read the response">');
    d.response(model, call.op);
    if (ctx.has('errors')) d.add('If the call fails, see [Errors](guide:errors).');
    d.add('</Step>');
  } else {
    const op = model.operations.find((o) => !o.deprecated && usableId(o.id)) ?? model.operations[0]!;
    d.add('<Step title="Make your first call">', 'Pick an operation from the API reference and send it to {{base_url}}.');
    if (usableId(op.id)) {
      d.add(`<Operation id="${op.id}" />`);
      d.operations.add(op.id);
    }
    d.add('</Step>');
    d.gaps.push('No operation could be called with values taken from the spec, so the quickstart has no runnable sample. Add parameter and request body examples to the spec.');
  }
  d.add('</Steps>');

  const next: [string, string, string][] = [];
  for (const [slug, title, text] of [
    ['authentication', 'Authentication', 'How credentials are sent.'],
    ['errors', 'Errors', 'The error responses the API documents.'],
    ['pagination', 'Pagination', 'How to page through lists.'],
  ] as const) {
    if (ctx.has(slug)) next.push([slug, title, text]);
  }
  for (const r of ctx.resources) {
    if (next.length >= 6) break;
    for (const s of [`${r.slug}/manage`, `${r.slug}/browse`]) if (ctx.has(s)) next.push([s, capitalize(r.noun), `Work with ${r.noun} step by step.`]);
  }
  if (next.length) {
    d.add('## Next steps', '<CardGroup cols="2">');
    for (const [slug, title, text] of next) d.add(`<Card title="${attr(title)}" href="guide:${slug}">`, text, '</Card>');
    d.add('</CardGroup>');
  }
  return d.finish('quickstart', 'quickstart', 'Quickstart', `Make your first call to ${meta(model.title, 120)}.`);
}

// ---------------------------------------------------------------------------------------------
// Cross-cutting concept pages

export function errorsPage(ctx: Ctx): Result {
  const { model } = ctx;
  const info = findErrors(model);
  if (!info) return { page: 'errors', reason: 'no operation documents an error response' };
  const d = new Doc();
  d.add('{{api_name}} reports failures with HTTP status codes. This page lists the error responses the API description documents.');
  d.add('## Status codes', table(['Status', 'Most common description', 'Operations'], info.statuses.map((s) => [code(s.status), prose(s.description, 160), String(s.count)])));
  if (info.statuses.some((s) => s.status.toLowerCase() === 'default')) d.add(`${code('default')} covers any status code that is not listed for an operation.`);
  if (info.schemaName && usableSchema(info.schemaName)) {
    d.add('## Error body', `${info.schemaShare >= 0.999 ? 'Error responses' : 'Most error responses'} use the ${schemaLink(info.schemaName)} schema.`, `<Schema ref="${info.schemaName}" />`);
  } else d.gaps.push('Error responses share no named schema, so the error body is not described.');
  const silent = model.operations.filter((op) => !op.responses.some((r) => /^([45]|default)/i.test(r.status)));
  if (silent.length) d.gaps.push(`${silent.length} of ${model.operations.length} operations document no error response.`);
  return d.finish('errors', 'concept', 'Errors', `The error responses ${meta(model.title, 120)} documents, and what they mean.`);
}

export function paginationPage(ctx: Ctx): Result {
  const { model, checker } = ctx;
  const info = findPagination(model);
  if (!info) return { page: 'pagination', reason: 'no list operation takes pagination parameters' };
  const d = new Doc();
  const kind = { cursor: 'a cursor', offset: 'an offset and a limit', page: 'page numbers' }[info.style];
  d.add(`List operations in {{api_name}} return results a page at a time, using ${kind}.`);
  d.add('## Request parameters', table(['Parameter', 'Description'], [...info.params].map(([n, desc]) => [code(n), prose(desc, 240)])));
  if (info.responseFields.size) d.add('## Response fields', table(['Field', 'Description'], [...info.responseFields].map(([n, desc]) => [code(n), prose(desc, 240)])));
  else d.gaps.push('The spec does not show how a response says whether more results exist.');

  const ex = info.example;
  if (ex && usableId(ex.op.id)) {
    const sizes: Record<string, Json>[] = ex.sizeParam ? [10, 20, 5, 50, 100, 1].map((n) => ({ [ex.sizeParam!]: n })) : [];
    sizes.push({});
    const first = sizes.map((q) => buildValues(model, checker, ex.op, {}, q)).find((b) => b.ok);
    if (first) {
      d.add('## Example', `${opLink(ex.op)} is one of the operations that paginates.`);
      const carry = ex.cursorParam && ex.nextField ? buildValues(model, checker, ex.op, { [ex.cursorParam]: '{{next_cursor}}' }, first.values.query ?? {}) : undefined;
      if (carry?.ok) {
        d.sample(ex.op, first, { title: 'Request the first page', capture: ['next_cursor', `$.${ex.nextField}`] });
        d.add(`The response carries the position of the next page in ${code(ex.nextField!)}. Send it as ${code(ex.cursorParam!)} to continue.`);
        d.sample(ex.op, carry, { title: 'Request the next page' });
      } else d.sample(ex.op, first);
    }
  }
  d.add('## Operations that paginate', opList(info.operations));
  for (const op of info.operations.slice(0, 12)) if (usableId(op.id)) d.operations.add(op.id);
  return d.finish('pagination', 'concept', 'Pagination', `How to page through list results in ${meta(model.title, 120)}.`);
}

export function idempotencyPage(ctx: Ctx): Result {
  const { model, checker } = ctx;
  const info = findIdempotency(model);
  if (!info) return { page: 'idempotency', reason: 'no operation takes an idempotency header' };
  const d = new Doc();
  d.add(`${info.operations.length === 1 ? 'One operation in {{api_name}} accepts' : `${info.operations.length} operations in {{api_name}} accept`} the ${code(info.header)} header.`, prose(info.description, 600));
  if (!info.description) d.gaps.push(`The spec does not describe the '${info.header}' header. Explain what the API does with a repeated key.`);
  for (const op of info.operations) {
    if (!usableId(op.id)) continue;
    const built = buildValues(model, checker, op);
    if (!built.ok) continue;
    d.add('## Example', `${opLink(op)} with a generated key:`);
    d.sample(op, built);
    break;
  }
  d.add('## Operations that accept the header', opList(info.operations));
  for (const op of info.operations.slice(0, 12)) if (usableId(op.id)) d.operations.add(op.id);
  return d.finish('idempotency', 'concept', 'Idempotency', `Which operations in ${meta(model.title, 120)} accept an idempotency key.`);
}

export function rateLimitsPage(ctx: Ctx): Result {
  const { model } = ctx;
  const info = findRateLimits(model);
  if (!info) return { page: 'rate-limits', reason: 'the spec documents no 429 response or rate limit header' };
  const d = new Doc();
  d.add('{{api_name}} limits how often it can be called.');
  if (info.description !== undefined) d.add(`A request over the limit returns ${code('429')}${prose(info.description, 240) ? `: ${prose(info.description, 240).replace(/[.\s]+$/, '')}.` : '.'}`);
  if (info.headers.size) d.add('## Headers', table(['Header', 'Description'], [...info.headers].map(([h, desc]) => [code(h), prose(desc, 240)])));
  d.add('## Operations that document a limit', opList(info.operations));
  for (const op of info.operations.slice(0, 12)) if (usableId(op.id)) d.operations.add(op.id);
  d.gaps.push('The spec does not state the limits themselves (requests per period). Add them if they are public.');
  return d.finish('rate-limits', 'concept', 'Rate limits', `How ${meta(model.title, 120)} signals that you are calling it too often.`);
}

export function webhooksPage(ctx: Ctx): Result {
  const { model } = ctx;
  const callbacks = model.operations.filter((op) => op.hasCallbacks);
  if (model.webhooks.length === 0 && callbacks.length === 0) return { page: 'webhooks', reason: 'the spec defines no webhooks or callbacks' };
  const d = new Doc();
  d.add('{{api_name}} sends HTTP requests to your server when events happen.');
  if (model.webhooks.length) {
    d.add('## Events', table(['Event', 'Description', 'Payload'], model.webhooks.map((w) => [code(w.name), prose(w.summary ?? w.description, 200), w.schemaName && usableSchema(w.schemaName) ? schemaLink(w.schemaName) : ''])));
  }
  if (callbacks.length) {
    d.add('## Callbacks', 'These operations take a URL and call it back later:', opList(callbacks));
    for (const op of callbacks.slice(0, 12)) if (usableId(op.id)) d.operations.add(op.id);
  }
  d.gaps.push('The spec does not say how to register a webhook URL or verify that a delivery is genuine. Add both.');
  return d.finish('webhooks', 'concept', 'Webhooks', `The events ${meta(model.title, 120)} sends to your server.`);
}

// ---------------------------------------------------------------------------------------------
// Flows: how-to guides and tutorials

function step(d: Doc, title: string, op: Operation, built: BuiltValues, capture?: [string, string], after?: string): void {
  d.add(`<Step title="${attr(title)}">`, opIntro(op));
  d.sample(op, built, { capture });
  d.add(after, '</Step>');
}

/** Steps that create the records a later request body refers to by identifier. */
function prerequisiteSteps(d: Doc, ctx: Ctx, pre: PrereqState): void {
  for (const p of pre.steps) {
    const one = singular(p.resource.noun);
    const summary = prose(p.op.summary, 160).replace(/[.\s]+$/, '');
    d.add(`<Step title="${attr(`Create ${article(one)} to refer to`)}">`);
    d.add(`The request body of ${opLink(p.neededBy)} refers to ${article(one)} by ${code(p.field)}, so this guide creates one first.`, `Call ${opLink(p.op)}${summary ? `: ${summary}.` : '.'}`);
    d.sample(p.op, p.built, { capture: [p.variable, p.idPath] });
    d.add(`The identifier is at ${code(p.idPath)} in the response. Later steps send it as ${code(p.field)}.`);
    const guide = `${p.resource.slug}/manage`;
    if (ctx.has(guide)) d.add(`For more on ${p.resource.noun}, see [${capitalize(p.resource.noun)}](guide:${guide}).`);
    d.add('</Step>');
  }
  if (pre.unresolved.size) {
    d.gaps.push(`Samples send example values for ${[...pre.unresolved].sort().map((f) => `'${f}'`).join(', ')}, which no earlier step produces. Say where a reader gets them.`);
  }
}

const prerequisiteIntro = (pre: PrereqState) => {
  const nouns = [...new Set(pre.steps.map((p) => article(singular(p.resource.noun))))];
  if (!nouns.length) return '';
  return ` Before that, it creates ${nouns.length > 1 ? `${nouns.slice(0, -1).join(', ')} and ${nouns.at(-1)}` : nouns[0]}, which the requests refer to by identifier.`;
};

export function resourcePage(ctx: Ctx, r: Resource): Result {
  const { model, checker } = ctx;
  const one = singular(r.noun);
  const manage = `${r.slug}/manage`;
  if (!r.itemPath || !r.idParam) return { page: manage, reason: `${r.collectionPath} has no operations on a single item, so there is no flow to describe` };
  const ok = (op: Operation | undefined): op is Operation => !!op && usableId(op.id);
  const variable = idVariable(r);
  const bind = { [r.idParam]: `{{${variable}}}` };

  // The flow starts from a call that yields an identifier: create, or failing that, list.
  let source: 'create' | 'list' | undefined;
  let first: BuiltValues | undefined;
  let path: string | undefined;
  let why = '';
  if (ok(r.create)) {
    first = buildValues(model, checker, r.create);
    path = idPathInResponse(model, r.create, r.idParam);
    if (first.ok && path) source = 'create';
    else why = !first.ok ? `${r.create.id}: ${first.reason}` : `the response of ${r.create.id} does not show where the new identifier is`;
  }
  if (!source && ok(r.list)) {
    first = buildValues(model, checker, r.list);
    path = firstIdPathInList(model, r.list, r.idParam);
    if (first.ok && path) source = 'list';
    else why ||= !first.ok ? `${r.list.id}: ${first.reason}` : `the response of ${r.list.id} does not show where item identifiers are`;
  }
  if (!source || !first || !path) return { page: manage, reason: why || 'no create or list operation to start from' };

  const follow: [string, Operation, BuiltValues][] = [];
  const notes: string[] = [];
  const tryAdd = (title: string, op: Operation | undefined) => {
    if (!ok(op)) return;
    const b = buildValues(model, checker, op, bind);
    if (b.ok) follow.push([title, op, b]);
    else notes.push(`${op.id} was left out: ${b.reason}.`);
  };
  tryAdd(`Retrieve the ${one}`, r.get);
  tryAdd(`Update the ${one}`, r.update);
  if (source === 'create' && ok(r.list)) {
    const b = buildValues(model, checker, r.list);
    if (b.ok) follow.push([`List ${r.noun}`, r.list, b]);
  }
  tryAdd(`Delete the ${one}`, r.remove);
  // Identifiers in request bodies: the resource's own comes from the first call, others from
  // records created beforehand.
  const pre = newPrereqState([variable]);
  if (source === 'create') first = bindBodyIds(model, checker, ctx.resources, r.create!, first, pre, { exclude: [r] });
  for (const f of follow) f[2] = bindBodyIds(model, checker, ctx.resources, f[1], f[2], pre, { exclude: [r], available: { [r.idParam]: `{{${variable}}}` } });
  const slug = source === 'create' ? manage : `${r.slug}/browse`;
  if (follow.filter(([, op]) => op !== r.list).length === 0) return { page: slug, reason: `only one usable operation on ${r.noun}${notes.length ? ` (${notes.join(' ')})` : ''}; a guide would restate the reference` };

  const d = new Doc();
  d.gaps.push(...notes);
  const verbs = follow.map(([, op]) => (op === r.get ? 'retrieve' : op === r.update ? 'update' : op === r.remove ? 'delete' : 'list'));
  const list = verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}` : verbs[0]!;
  const firstOp = source === 'create' ? r.create! : r.list!;
  if (source === 'create') d.add(`This guide creates ${article(one)}, then uses its identifier to ${list} it. Each step carries the identifier forward from the call that creates it.${prerequisiteIntro(pre)}`);
  else d.add(`This guide lists ${r.noun}, takes the identifier of the first one, and uses it to ${list} it.${prerequisiteIntro(pre)}`);
  d.add('<Steps>');
  prerequisiteSteps(d, ctx, pre);
  d.add(`<Step title="${attr(source === 'create' ? `Create ${article(one)}` : `List ${r.noun}`)}">`, opIntro(firstOp));
  d.sample(firstOp, first, { capture: [variable, path] });
  d.response(model, firstOp);
  d.add(`The identifier is at ${code(path)} in the response. The following steps send it as ${code(r.idParam)}.`, '</Step>');
  for (const [title, op, built] of follow) step(d, title, op, built);
  d.add('</Steps>');

  const manages = verbs.includes('update') || verbs.includes('delete');
  const title = source === 'create' ? `${manages ? 'Create and manage' : 'Create and retrieve'} ${r.noun}` : `${manages ? 'Find and manage' : 'List and retrieve'} ${r.noun}`;
  return d.finish(slug, 'how-to', title.slice(0, 80), `${capitalize(source === 'create' ? `create ${article(one)}` : `list ${r.noun}`)}, then ${list} it, passing its identifier from call to call.`.slice(0, 200));
}

/** A parent resource and a collection nested under it: create the parent, then work inside it. */
export function nestedTutorial(ctx: Ctx, parent: Resource, child: Resource): Result {
  const { model, checker } = ctx;
  const slug = `tutorials/${child.slug}`;
  const ok = (op: Operation | undefined): op is Operation => !!op && usableId(op.id);
  if (!ok(parent.create) || !parent.idParam || !ok(child.create)) return { page: slug, reason: 'parent or child has no create operation' };
  const pVar = idVariable(parent);
  const pre = newPrereqState([pVar]);
  const pBuilt = bindBodyIds(model, checker, ctx.resources, parent.create, buildValues(model, checker, parent.create), pre, { exclude: [parent, child] });
  const pPath = idPathInResponse(model, parent.create, parent.idParam);
  if (!pBuilt.ok || !pPath) return { page: slug, reason: !pBuilt.ok ? `${parent.create.id}: ${pBuilt.reason}` : `the response of ${parent.create.id} does not show where the new identifier is` };
  const bind: Record<string, string> = { [parent.idParam]: `{{${pVar}}}` };
  const cBuilt = bindBodyIds(model, checker, ctx.resources, child.create, buildValues(model, checker, child.create, bind), pre, { exclude: [parent, child], available: bind });
  if (!cBuilt.ok) return { page: slug, reason: `${child.create.id}: ${cBuilt.reason}` };

  const pOne = singular(parent.noun);
  const cOne = singular(child.noun);
  const d = new Doc();
  d.add(`This tutorial creates ${article(pOne)}, then adds ${article(cOne)} to it. The identifier of the ${pOne} is used in every call that follows.${prerequisiteIntro(pre)}`);
  d.add('<Steps>');
  prerequisiteSteps(d, ctx, pre);
  step(d, `Create ${article(pOne)}`, parent.create, pBuilt, [pVar, pPath], `The identifier is at ${code(pPath)} in the response.`);

  let cVar = idVariable(child);
  if (cVar === pVar) cVar = `${cOne.replace(/[^a-z0-9]+/g, '_')}_${cVar}`;
  const cPath = child.idParam && child.idParam !== parent.idParam ? idPathInResponse(model, child.create, child.idParam) : undefined;
  const getChild = cPath && ok(child.get) ? buildValues(model, checker, child.get, { ...bind, [child.idParam!]: `{{${cVar}}}` }) : undefined;
  step(d, `Add ${article(cOne)}`, child.create, cBuilt, getChild?.ok ? [cVar, cPath!] : undefined);
  if (ok(child.list)) {
    const b = buildValues(model, checker, child.list, bind);
    if (b.ok) step(d, `List the ${child.noun}`, child.list, b);
  }
  if (getChild?.ok) step(d, `Retrieve the ${cOne}`, child.get!, getChild);
  d.add('</Steps>');
  return d.finish(slug, 'tutorial', `Create ${article(pOne)} with ${child.noun}`.slice(0, 80), `Create ${article(pOne)}, then add ${child.noun} to it, carrying identifiers from one call to the next.`.slice(0, 200));
}

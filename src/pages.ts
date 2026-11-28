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
import { defaultLabel, operationExtensions, textValues, type Settings } from './extensions.ts';
import { deref, schemaRefName, successResponse, type Json, type Operation, type SpecModel } from './spec.ts';
import { attr, capitalize, code, frontmatter, meta, plainText, prose, singular, slugify, words } from './text.ts';

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
  /** The spec tag the page belongs under in navigation, when its resource has one. */
  group?: string;
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
  /** What this build does with the spec's vendor extensions. */
  settings: Settings;
}

export type Result = Page | Skipped;
export const isPage = (r: Result): r is Page => 'body' in r;

// ---------------------------------------------------------------------------------------------
// Building blocks

/**
 * An identifier can be written into a component attribute: any text without a double quote or a
 * line break (contract 4.5). Angle brackets are left out too, because this module's own validator
 * reads tags line by line.
 */
const usableId = (id: string) => id !== '' && !/["\r\n<>]/.test(id);
const usableSchema = usableId;

/** The part of a link target after its scheme: the listed characters as themselves, the rest percent-encoded. */
const target = (id: string) => Array.from(id, (c) => (/^[A-Za-z0-9_.\-/:~@$!*+,;=]$/.test(c) ? c : [...new TextEncoder().encode(c)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))).join('');

const opLink = (op: Operation) => (usableId(op.id) ? `[${code(op.id)}](op:${target(op.id)})` : code(op.id));
const schemaLink = (name: string) => (usableSchema(name) ? `[${code(name)}](schema:${target(name)})` : code(name));
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
    // Values built from types alone are valid but not real. The page says so, where a reader will
    // see it, and names the calls; otherwise a flow of made-up values reads as one that works.
    const made = [...new Set(this.placeholders)];
    if (made.length) {
      const names = made.slice(0, 4).map((id) => code(id));
      const which = `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}${made.length > 4 ? ` and ${made.length - 4} more` : ''}`;
      this.lines.splice(this.lines[0] !== undefined && !this.lines[0].startsWith('<') && !this.lines[0].startsWith('#') ? 2 : 0, 0, '<Callout type="warning" title="Placeholder values">', '', `The API description gives no example values for ${which}. The values sent on this page for ${made.length > 1 ? 'those calls' : 'that call'} are built from each field's type. They fit the schema but are not real, so the API may refuse them. Replace them with your own before you rely on this page.`, '', '</Callout>', '');
    }
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

/**
 * What the spec says about an operation in vendor extensions that this build's settings give a
 * role: a permission, something required, or a note. One line each, in the spec's own words.
 */
function extensionLines(ctx: Ctx, op: Operation): string[] {
  const out: string[] = [];
  for (const [name, value] of operationExtensions(ctx.model, op)) {
    const setting = ctx.settings.extensions?.[name];
    if (!setting || setting.role === 'ignore' || setting.role === 'errors') continue;
    const values = textValues(value);
    if (values === undefined || value === false) continue;
    const label = prose(setting.label ?? defaultLabel(name, setting.role), 80);
    if (values.length === 0) {
      if (value === true) out.push(`**${label}.**`);
      continue;
    }
    const shown = setting.role === 'note' ? values.map((v) => prose(v, 600)).join('; ') : values.map((v) => code(v)).join(', ');
    out.push(`**${label}:** ${shown}${setting.role === 'note' && /[.!?]$/.test(shown) ? '' : '.'}`);
  }
  return out;
}

const opIntro = (ctx: Ctx, op: Operation) => {
  const summary = prose(op.summary, 160).replace(/[.\s]+$/, '');
  // A flow step keeps the operation's rules, which specs often put late in the description.
  let desc = prose(op.description, 1200);
  // Say so when the description was shortened, and point at the reference, which has all of it.
  if (desc.endsWith(' …')) desc = desc.slice(0, -2) + (usableId(op.id) ? ` The reference for ${opLink(op)} has the rest of this description.` : ' The reference has the rest of this description.');
  const same = (x?: string) => plainText(x).toLowerCase().replace(/s\b|[^a-z0-9]/g, '');
  return [`Call ${opLink(op)}${summary ? `: ${summary}.` : '.'}`, desc && same(op.description) !== same(op.summary) ? desc : '', ...extensionLines(ctx, op)].filter(Boolean).join('\n\n');
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
    // A path parameter can only be filled from the spec's example, which names no record the reader
    // has. A first call should work, so one without path parameters is strongly preferred.
    if (!op.parameters.some((p) => p.in === 'path')) score += 20;
    else score -= 40;
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
    // The portal shows its own "get a key" link (contract 9), so the page says nothing about issuing.
    d.gaps.push('The spec does not say how credentials are issued. The portal links to where a reader gets a key; make sure that link is set.');
    d.add('</Step>', '<Step title="Authenticate your requests">', t.how, callIsOpen ? `${opLink(call!.op)}, the call below, is one of the operations that needs no credentials.` : 'The samples on this page include your credentials for you.');
    if (ctx.has('authentication')) d.add('For the details, see [Authentication](guide:authentication).');
    d.add('</Step>');
  } else if (requirement) {
    d.gaps.push(`Operations require the security scheme '${schemeName}', which the spec does not define.`);
  } else {
    d.gaps.push('The spec declares no authentication. If the API needs credentials, add that step to the quickstart.');
  }

  if (call) {
    d.add('<Step title="Make your first call">', opIntro(ctx, call.op), 'Requests go to {{base_url}}.');
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
  if (!info) return errorsFromExtension(ctx) ?? { page: 'errors', reason: 'no operation documents an error response' };
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

/** The values an extension with a given role takes across operations, with the operations that carry each. */
function extensionValues(ctx: Ctx, role: 'permission' | 'errors'): { name: string; byValue: Map<string, Operation[]> }[] {
  const out = new Map<string, Map<string, Operation[]>>();
  for (const op of ctx.model.operations) {
    if (op.deprecated) continue;
    for (const [name, value] of operationExtensions(ctx.model, op)) {
      if (ctx.settings.extensions?.[name]?.role !== role) continue;
      for (const v of textValues(value) ?? []) {
        const byValue = out.get(name) ?? new Map<string, Operation[]>();
        byValue.set(v, [...(byValue.get(v) ?? []), op]);
        out.set(name, byValue);
      }
    }
  }
  return [...out].map(([name, byValue]) => ({ name, byValue }));
}

/** Errors as an extension describes them, for a spec that declares no error responses. */
function errorsFromExtension(ctx: Ctx): Result | undefined {
  const found = extensionValues(ctx, 'errors');
  if (found.length === 0) return undefined;
  const d = new Doc();
  d.add('The API description declares no error responses. It describes errors in a vendor extension, and this page shows what it says there, in its own words.');
  for (const { name, byValue } of found) {
    const rows = [...byValue].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    d.add(`## ${prose(ctx.settings.extensions?.[name]?.label ?? 'What the description says', 80)}`, `From ${code(name)}, on ${rows.reduce((n, r) => n + r[1].length, 0)} operations. The most common texts:`);
    d.add(table(['The description says', 'Operations'], rows.slice(0, 12).map(([text, ops]) => [prose(text, 600), String(ops.length)])));
    if (rows.length > 12) d.add(`${rows.length - 12} more texts appear on fewer operations. Each operation's reference has its own.`);
  }
  d.gaps.push('The errors page is built from a vendor extension, as text. The spec declares no error responses, so no status table or error schema could be shown.');
  return d.finish('errors', 'concept', 'Errors', `What ${meta(ctx.model.title, 120)} says about how calls fail.`);
}

export function permissionsPage(ctx: Ctx): Result {
  const found = extensionValues(ctx, 'permission');
  if (found.length === 0) return { page: 'permissions', reason: 'no vendor extension has the role permission in this build\'s settings' };
  const d = new Doc();
  d.add('Some operations in {{api_name}} need a permission. This page lists the permissions the API description names and the operations that need each.');
  for (const { name, byValue } of found) {
    const rows = [...byValue].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    d.add(`## ${prose(ctx.settings.extensions?.[name]?.label ?? defaultLabel(name, 'permission'), 80)}`, `From ${code(name)} in the API description.`);
    d.add(table(['Permission', 'Operations'], rows.map(([perm, ops]) => [code(perm), `${ops.slice(0, 4).map(opLink).join(', ')}${ops.length > 4 ? ` and ${ops.length - 4} more` : ''}`])));
  }
  d.gaps.push('The spec names permissions but does not say how a caller is given one. Add that.');
  return d.finish('permissions', 'concept', 'Permissions', `The permissions ${meta(ctx.model.title, 120)} names, and which operations need each.`);
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
  if (!info) return { page: 'idempotency', reason: 'no operation takes an idempotency key in a header or in its request body' };
  const d = new Doc();
  const place = info.where === 'header' ? `the ${code(info.name)} header` : `${code(info.name)} in the request body`;
  d.add(`${info.operations.length === 1 ? 'One operation in {{api_name}} accepts' : `${info.operations.length} operations in {{api_name}} accept`} ${place}.`, prose(info.description, 600));
  if (!info.description) d.gaps.push(`The spec does not describe '${info.name}'. Explain what the API does with a repeated key.`);
  for (const op of info.operations) {
    if (!usableId(op.id)) continue;
    const built = buildValues(model, checker, op);
    if (!built.ok || !JSON.stringify(built.values).includes('{{idempotency_key}}')) continue;
    d.add('## Example', `${opLink(op)} with a generated key:`);
    d.sample(op, built);
    break;
  }
  d.add('## Operations that accept a key', opList(info.operations));
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

/** A step is named as the spec names the operation ("Book a visit"), and generically only when it has no summary. */
const stepTitle = (op: Operation, fallback: string) => attr(op.summary ?? '', 80) || attr(fallback);

function step(ctx: Ctx, d: Doc, title: string, op: Operation, built: BuiltValues, capture?: [string, string], after?: string): void {
  d.add(`<Step title="${stepTitle(op, title)}">`, opIntro(ctx, op));
  d.sample(op, built, { capture });
  d.add(after, '</Step>');
}

/**
 * The records a later request body refers to by identifier, created in a block of their own
 * before the task, so the task's steps start at the task.
 */
function prerequisiteBlock(d: Doc, ctx: Ctx, pre: PrereqState): void {
  if (pre.unresolved.size) {
    d.gaps.push(`Samples send example values for ${[...pre.unresolved].sort().map((f) => `'${f}'`).join(', ')}, which no earlier step produces. Say where a reader gets them.`);
  }
  if (pre.steps.length === 0) return;
  const nouns = [...new Set(pre.steps.map((p) => article(singular(p.resource.noun))))];
  d.add('## Before you start', `The requests below refer to ${nouns.length > 1 ? `${nouns.slice(0, -1).join(', ')} and ${nouns.at(-1)}` : nouns[0]} by identifier. These steps create ${pre.steps.length > 1 ? 'them' : 'one'} and capture ${pre.steps.length > 1 ? 'the identifiers' : 'its identifier'}. To use a record you already have, send its identifier instead.`);
  d.add('<Steps>');
  for (const p of pre.steps) {
    const one = singular(p.resource.noun);
    d.add(`<Step title="${stepTitle(p.op, `Create ${article(one)}`)}">`);
    d.add(`${opLink(p.neededBy)} refers to ${article(one)} by ${code(p.field)}. Call ${opLink(p.op)} to create one.`);
    d.add(...extensionLines(ctx, p.op));
    d.sample(p.op, p.built, { capture: [p.variable, p.idPath] });
    d.add(`The identifier is at ${code(p.idPath)} in the response. Later steps send it as ${code(p.field)}.`);
    const guide = `${p.resource.slug}/manage`;
    if (ctx.has(guide)) d.add(`For more on ${p.resource.noun}, see [${capitalize(p.resource.label)}](guide:${guide}).`);
    d.add('</Step>');
  }
  d.add('</Steps>');
}

export function resourcePage(ctx: Ctx, r: Resource): Result {
  const { model, checker } = ctx;
  const one = singular(r.noun);
  const manage = `${r.slug}/manage`;
  if (!r.itemPath || !r.idParam) return { page: manage, reason: `${r.collectionPath} has no operations on a single item, so there is no flow to describe` };
  // A collection under a parent record needs that record's identifier. An example in the spec is
  // not a record in the reader's account, so this guide would not run; the tutorial creates the parent.
  if (r.parentParams.length > 0) return { page: manage, reason: `${r.collectionPath} sits under a parent record, whose identifier this guide would have to make up; a tutorial that creates the parent covers it where one can be written` };
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
  // A record the guide did not create is only read. Changing or deleting whatever a list returns
  // first would act on a record the reader never chose.
  if (source === 'create') tryAdd(`Update the ${one}`, r.update);
  if (source === 'create' && ok(r.list)) {
    const b = buildValues(model, checker, r.list);
    if (b.ok) follow.push([`List ${r.noun}`, r.list, b]);
  }
  if (source === 'create') tryAdd(`Delete the ${one}`, r.remove);
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
  if (source === 'create') d.add(`This guide creates ${article(one)}, then uses its identifier to ${list} it. Each step carries the identifier forward from the call that creates it.`);
  else d.add(`This guide lists ${r.noun}, takes the identifier of the first one, and uses it to ${list} it.`);
  prerequisiteBlock(d, ctx, pre);
  if (pre.steps.length) d.add(`## ${capitalize(source === 'create' ? `create the ${one}, then ${list} it` : `list ${r.noun}`)}`);
  d.add('<Steps>');
  d.add(`<Step title="${stepTitle(firstOp, source === 'create' ? `Create ${article(one)}` : `List ${r.noun}`)}">`, opIntro(ctx, firstOp));
  d.sample(firstOp, first, { capture: [variable, path] });
  d.response(model, firstOp);
  d.add(`The identifier is at ${code(path)} in the response. The following steps send it as ${code(r.idParam)}.`, '</Step>');
  for (const [title, op, built] of follow) step(ctx, d, title, op, built);
  d.add('</Steps>');

  const manages = verbs.includes('update') || verbs.includes('delete');
  const title = source === 'create' ? `${manages ? 'Create and manage' : 'Create and retrieve'} ${r.label}` : `List and retrieve ${r.label}`;
  const page = d.finish(slug, 'how-to', title.slice(0, 80), `${capitalize(source === 'create' ? `create ${article(one)}` : `list ${r.label}`)}, then ${list} it, passing its identifier from call to call.`.slice(0, 200));
  page.group = r.tag;
  return page;
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
  d.add(`This tutorial creates ${article(pOne)}, then adds ${article(cOne)} to it. The identifier of the ${pOne} is used in every call that follows.`);
  prerequisiteBlock(d, ctx, pre);
  if (pre.steps.length) d.add(`## ${capitalize(`create the ${pOne} and add ${article(cOne)}`)}`);
  d.add('<Steps>');
  step(ctx, d, `Create ${article(pOne)}`, parent.create, pBuilt, [pVar, pPath], `The identifier is at ${code(pPath)} in the response.`);

  let cVar = idVariable(child);
  if (cVar === pVar) cVar = `${cOne.replace(/[^a-z0-9]+/g, '_')}_${cVar}`;
  const cPath = child.idParam && child.idParam !== parent.idParam ? idPathInResponse(model, child.create, child.idParam) : undefined;
  const getChild = cPath && ok(child.get) ? buildValues(model, checker, child.get, { ...bind, [child.idParam!]: `{{${cVar}}}` }) : undefined;
  step(ctx, d, `Add ${article(cOne)}`, child.create, cBuilt, getChild?.ok ? [cVar, cPath!] : undefined);
  if (ok(child.list)) {
    const b = buildValues(model, checker, child.list, bind);
    if (b.ok) step(ctx, d, `List the ${child.noun}`, child.list, b);
  }
  if (getChild?.ok) step(ctx, d, `Retrieve the ${cOne}`, child.get!, getChild);
  d.add('</Steps>');
  const page = d.finish(slug, 'tutorial', `Create ${article(pOne)} with ${child.noun}`.slice(0, 80), `Create ${article(pOne)}, then add ${child.noun} to it, carrying identifiers from one call to the next.`.slice(0, 200));
  page.group = parent.tag;
  return page;
}

/**
 * What a resource can be made to do, beyond being created, read and changed: an operation on
 * `/things/{id}/verb`, such as taking a payment on an order. Each gets a guide of its own, titled
 * as the spec titles the operation, that creates a fresh record and then calls the operation on it.
 */
export function actionPages(ctx: Ctx, r: Resource): Result[] {
  const { model, checker } = ctx;
  const out: Result[] = [];
  if (!r.itemPath || !r.idParam || r.parentParams.length > 0 || !r.create || !usableId(r.create.id)) return out;
  const idPath = idPathInResponse(model, r.create, r.idParam);
  if (!idPath) return out;
  const variable = idVariable(r);
  const one = singular(r.noun);
  const taken = new Set(['manage', 'browse']);
  const prefix = r.itemPath + '/';
  for (const op of model.operations) {
    if (op.deprecated || !op.path.startsWith(prefix) || !['post', 'put', 'patch', 'delete'].includes(op.method) || !usableId(op.id)) continue;
    const rest = op.path.slice(prefix.length);
    if (rest.includes('/') || rest.includes('{')) continue;
    // A collection under the record, one that can be listed or has items of its own, is a tutorial's subject.
    const collection = ctx.resources.find((c) => c.collectionPath === op.path);
    if (collection && (collection.list || collection.itemPath)) continue;
    const verb = slugify(rest);
    if (!verb || taken.has(verb) || model.operations.some((o) => o !== op && o.path === op.path && ['post', 'put', 'patch', 'delete'].includes(o.method) && model.operations.indexOf(o) < model.operations.indexOf(op))) continue;
    taken.add(verb);
    const slug = `${r.slug}/${verb}`;

    const pre = newPrereqState([variable]);
    const made = bindBodyIds(model, checker, ctx.resources, r.create, buildValues(model, checker, r.create), pre, { exclude: [r] });
    if (!made.ok) {
      out.push({ page: slug, reason: `${r.create.id}: ${made.reason}` });
      continue;
    }
    const bind = { [r.idParam]: `{{${variable}}}` };
    const built = bindBodyIds(model, checker, ctx.resources, op, buildValues(model, checker, op, bind), pre, { exclude: [r], available: bind });
    if (!built.ok) {
      out.push({ page: slug, reason: `${op.id}: ${built.reason}` });
      continue;
    }
    const d = new Doc();
    const summary = meta(op.summary, 80).replace(/[.\s]+$/, '');
    const title = summary || capitalize(`${words(rest)} ${article(one)}`);
    d.add(`This guide creates ${article(one)}, then calls ${opLink(op)} on it. The ${one} is created here so that the call has a record of its own to act on.`);
    prerequisiteBlock(d, ctx, pre);
    if (pre.steps.length) d.add(`## ${prose(title)}`);
    d.add('<Steps>');
    step(ctx, d, `Create ${article(one)}`, r.create, made, [variable, idPath], `The identifier is at ${code(idPath)} in the response. The next step sends it as ${code(r.idParam)}.`);
    d.add(`<Step title="${stepTitle(op, title)}">`, opIntro(ctx, op));
    d.sample(op, built);
    d.response(model, op);
    d.add('</Step>', '</Steps>');
    const manage = `${r.slug}/manage`;
    if (ctx.has(manage)) d.add(`To retrieve, change or list ${r.noun}, see [${capitalize(r.label)}](guide:${manage}).`);
    const page = d.finish(slug, 'how-to', title.slice(0, 80), `${summary || title}. This guide creates ${article(one)} first, so the call has a record to act on.`.slice(0, 200));
    page.group = r.tag ?? op.tags[0];
    out.push(page);
  }
  return out;
}

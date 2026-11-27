// Validates a guides bundle against the guides contract (v0.2) before it leaves this module.
// Pure: takes the bundle's files in memory and the spec model.
//
// This is a pre-flight check, not a CommonMark parser. It reads pages line by line and, where it
// cannot be sure, rejects (`unsupported-syntax`). It uses the contract's codes and severities for
// the conditions it can see.

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { isAlias, isScalar, parseDocument, visit } from 'yaml';
import type { Json, Operation, SpecModel } from './spec.ts';
import { compareCodePoints } from './spec.ts';
import { SchemaChecker, undeclaredParameters, validateSampleValues } from './values.ts';

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;

export type Severity = 'error' | 'blocker' | 'warning';

export interface Finding {
  code: string;
  severity: Severity;
  file: string;
  line?: number;
  /** On `link-to-withheld-page` only: the path of the withheld page. */
  target?: string;
  message: string;
}

export interface ValidationReport {
  contractVersion: string;
  /** True when there is no finding of severity `error`. */
  ok: boolean;
  /** One value for the bundle. In 0.2 it equals `ok`: blockers do not make it false. */
  publishable: boolean;
  /** Slugs of the pages a blocker withholds, sorted by code point. */
  withheld: string[];
  findings: Finding[];
}

export const errorsOf = (r: ValidationReport): Finding[] => r.findings.filter((f) => f.severity === 'error');
export const warningsOf = (r: ValidationReport): Finding[] => r.findings.filter((f) => f.severity === 'warning');

export type BundleFiles = Map<string, Uint8Array>;

export const CONTRACT_VERSION = '0.2';
export const BUILTIN_VARIABLES = ['base_url', 'idempotency_key', 'api_name'];
/** Names that belong to the portal's sample generator and can never be captured. */
export const CREDENTIAL_VARIABLES = ['api_key', 'access_token', 'username', 'password'];
const PAGE_TYPES = ['quickstart', 'concept', 'how-to', 'tutorial', 'reference'];
const ASSET_TYPES = ['png', 'jpg', 'webp', 'gif', 'svg', 'pdf', 'json', 'zip'];
const MB = 1024 * 1024;

interface ComponentDef {
  attrs: Record<string, { required?: boolean; values?: string[] }>;
  /** The only component this one may sit directly inside. */
  parent?: string;
  /** The only component allowed directly inside this one. */
  only?: string;
  /** Markdown only: no component may appear inside. */
  noComponents?: boolean;
  /** 'void' must self-close, 'block' must not, 'either' may do both. */
  form: 'void' | 'block' | 'either';
}

export const COMPONENTS: Record<string, ComponentDef> = {
  Callout: { attrs: { type: { values: ['note', 'tip', 'warning', 'danger'] }, title: {} }, noComponents: true, form: 'block' },
  Steps: { attrs: {}, only: 'Step', form: 'block' },
  Step: { attrs: { title: { required: true } }, parent: 'Steps', form: 'block' },
  Tabs: { attrs: {}, only: 'Tab', form: 'block' },
  Tab: { attrs: { title: { required: true } }, parent: 'Tabs', form: 'block' },
  CardGroup: { attrs: { cols: { values: ['1', '2', '3', '4'] } }, only: 'Card', form: 'block' },
  Card: { attrs: { title: { required: true }, href: {} }, noComponents: true, form: 'either' },
  Operation: { attrs: { id: { required: true } }, form: 'void' },
  Schema: { attrs: { ref: { required: true } }, form: 'void' },
  Sample: { attrs: { operation: { required: true }, example: {}, title: {}, capture: {}, tryIt: { values: ['true', 'false'] } }, form: 'either' },
  Response: { attrs: { operation: { required: true }, status: { required: true } }, form: 'void' },
  Todo: { attrs: { title: {} }, noComponents: true, form: 'block' },
};

const CAPTURE_PAIR = /^([a-z][a-z0-9_]*)=(\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]*)\])*)$/;

/** Parses a `capture` attribute: `name=path` pairs separated by exactly one space (contract 4.3). */
export function parseCapture(value: string): { pairs: [string, string][]; bad: string[] } {
  const pairs: [string, string][] = [];
  const bad: string[] = [];
  for (const part of value.split(' ')) {
    const m = CAPTURE_PAIR.exec(part);
    if (m) pairs.push([m[1]!, m[2]!]);
    else bad.push(part);
  }
  return { pairs, bad };
}

/** The anchor of a heading, before it is made unique on its page (contract 4.5, steps 1 to 5). */
export function headingAnchor(text: string): string {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(^|[^\\])[*~]+/g, '$1')
    .replace(/(^|\s)_+(?=\S)|(?<=\S)_+(?=\s|$)/g, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1');
  let out = '';
  for (const ch of plain.replace(/[A-Z]/g, (c) => c.toLowerCase())) {
    if (/^[a-z0-9_]$/.test(ch)) out += ch;
    else if (/^[\s-]$/.test(ch)) out += '-';
    else if (ch.codePointAt(0)! > 127 && /^[\p{L}\p{M}\p{N}]$/u.test(ch)) out += ch;
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
}

/** Every heading anchor of a page body, unique in document order. */
export function pageAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const lines = text.split('\n');
  let i = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const atx = /^ {0,3}#{2,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    const setext = !atx && /^ {0,3}-{2,}\s*$/.test(line) && i > 0 && lines[i - 1]!.trim() !== '' && !/^ {0,3}([-*+>#]|\d+[.)])/.test(lines[i - 1]!) ? lines[i - 1]!.trim() : undefined;
    const heading = atx ? atx[1]! : setext;
    if (heading === undefined) continue;
    const base = headingAnchor(heading);
    let anchor = base;
    for (let n = 1; anchors.has(anchor); n++) anchor = `${base}-${n}`;
    anchors.add(anchor);
  }
  return anchors;
}

const validators = new Map<Json, (v: Json) => boolean>();

function checkSchema(value: Json, schema: Json): string[] {
  let fn = validators.get(schema);
  if (!fn) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    fn = ajv.compile(schema) as (v: Json) => boolean;
    validators.set(schema, fn);
  }
  if (fn(value)) return [];
  return ((fn as any).errors ?? []).map((e: Json) => `${e.instancePath || '/'} ${e.message}`);
}

/** Depth of a JSON value: the top-level value is 1, each object or array inside another is one deeper. */
export function jsonDepth(value: Json): number {
  let max = 0;
  const stack: [Json, number][] = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (d > max) max = d;
    if (v && typeof v === 'object') for (const x of Array.isArray(v) ? v : Object.values(v)) if (x && typeof x === 'object') stack.push([x, d + 1]);
  }
  return max;
}

export interface ValidateOptions {
  manifestSchema: Json;
  /** Schema of `report.json`. Without it the report is only checked for being JSON. */
  reportSchema?: Json;
  /** Hash of the spec the portal is publishing, when known. A mismatch is a warning. */
  publishedSpecSha256?: string;
}

export function validateBundle(files: BundleFiles, model: SpecModel, options: ValidateOptions): ValidationReport {
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, file: string, message: string, line?: number) =>
    findings.push(line === undefined ? { code, severity, file, message } : { code, severity, file, line, message });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (file: string, bytes: Uint8Array): string | undefined => {
    try {
      const text = decoder.decode(bytes);
      if (text.startsWith('\uFEFF')) add('error', 'invalid-encoding', file, 'File starts with a byte order mark.');
      if (text.includes('\r')) add('error', 'invalid-encoding', file, 'Line endings must be LF.');
      if (text.includes('\0')) add('error', 'invalid-encoding', file, 'File contains a NUL character.');
      return text;
    } catch {
      add('error', 'invalid-encoding', file, 'File is not valid UTF-8.');
      return undefined;
    }
  };

  // --- Layout and limits
  let total = 0;
  const pageSlugs = new Set<string>();
  const assets = new Set<string>();
  for (const [path, bytes] of files) {
    total += bytes.byteLength;
    if (path === 'guides.json' || path === 'report.json') continue;
    const under = /^(pages|assets)\/(.+)$/.exec(path);
    if (!under || (under[1] === 'pages' && !path.endsWith('.md'))) {
      add('error', 'unexpected-file', path, 'Only guides.json, report.json, pages/*.md and assets/* belong in a bundle.');
      continue;
    }
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.[a-z0-9]+$/.test(under[2]!) || under[2]!.length > 200) add('error', 'invalid-path', path, 'A path is lowercase segments of a-z, 0-9 and -, one extension, and at most 200 characters.');
    if (under[1] === 'pages') {
      pageSlugs.add(under[2]!.replace(/\.md$/, ''));
      if (bytes.byteLength > 2 * MB) add('error', 'size-limit', path, 'Page exceeds 2 MB.');
    } else {
      assets.add(under[2]!);
      const ext = /\.([a-z0-9]+)$/.exec(path)?.[1] ?? '';
      if (!ASSET_TYPES.includes(ext)) add('error', 'asset-type', path, `Asset type '${ext}' is not allowed.`);
      if (bytes.byteLength > 5 * MB) add('error', 'size-limit', path, 'Asset exceeds 5 MB.');
    }
  }
  if (total > 200 * MB) add('error', 'size-limit', 'guides.json', 'Bundle exceeds 200 MB.');
  if (files.size > 5000) add('error', 'size-limit', 'guides.json', 'Bundle holds more than 5,000 files.');

  // --- Manifest
  const navPages = new Map<string, number>();
  const manifestBytes = files.get('guides.json');
  if (!manifestBytes) add('error', 'missing-manifest', 'guides.json', 'The bundle has no guides.json.');
  else {
    if (manifestBytes.byteLength > MB) add('error', 'size-limit', 'guides.json', 'guides.json exceeds 1 MB.');
    const text = decode('guides.json', manifestBytes);
    let manifest: Json;
    try {
      manifest = text === undefined ? undefined : JSON.parse(text);
    } catch (e) {
      add('error', 'invalid-manifest', 'guides.json', `Not valid JSON: ${(e as Error).message}`);
    }
    if (manifest !== undefined && jsonDepth(manifest) > 64) {
      add('error', 'invalid-manifest', 'guides.json', 'JSON is nested deeper than 64.');
      manifest = undefined;
    }
    if (manifest !== undefined) {
      for (const m of checkSchema(manifest, options.manifestSchema)) add('error', 'invalid-manifest', 'guides.json', m);
      const walk = (items: Json, depth: number) => {
        for (const item of Array.isArray(items) ? items : []) {
          if (typeof item?.page === 'string') navPages.set(item.page, (navPages.get(item.page) ?? 0) + 1);
          else if (item && Array.isArray(item.items)) {
            if (depth + 1 > 3) {
              add('error', 'nav-depth', 'guides.json', `Group '${item.group}' is nested deeper than depth 3.`);
              continue;
            }
            walk(item.items, depth + 1);
          }
        }
      };
      walk(manifest?.nav, 0);
      for (const [slug, count] of navPages) {
        if (count > 1) add('error', 'duplicate-page', 'guides.json', `Page '${slug}' appears in nav ${count} times.`);
        if (!pageSlugs.has(slug)) add('error', 'missing-page', 'guides.json', `Nav refers to page '${slug}', which has no file.`);
      }
      for (const slug of pageSlugs) {
        if (!navPages.has(slug)) add('error', 'unlisted-page', `pages/${slug}.md`, 'Page file is not listed in nav.');
      }
      if (manifest?.contractVersion !== CONTRACT_VERSION) add('error', 'unsupported-contract-version', 'guides.json', `Contract version '${manifest?.contractVersion}' is not supported. This validator accepts ${CONTRACT_VERSION} only.`);
      const hash = manifest?.spec?.sha256;
      if (typeof hash === 'string' && hash !== model.sha256) add('warning', 'spec-hash-mismatch', 'guides.json', 'spec.sha256 differs from the spec the bundle is being checked against.');
      if (options.publishedSpecSha256 && hash !== options.publishedSpecSha256) add('warning', 'spec-hash-mismatch', 'guides.json', 'spec.sha256 differs from the published spec.');
    }
  }

  // --- Run report: never blocks
  const reportBytes = files.get('report.json');
  if (reportBytes) {
    const bad = (m: string) => add('warning', 'invalid-report', 'report.json', `${m} The report is ignored.`);
    if (reportBytes.byteLength > 2 * MB) add('error', 'size-limit', 'report.json', 'report.json exceeds 2 MB.');
    let text: string | undefined;
    try {
      text = decoder.decode(reportBytes);
    } catch {
      bad('Not valid UTF-8.');
    }
    if (text !== undefined) {
      try {
        const report = JSON.parse(text);
        if (jsonDepth(report) > 64) bad('JSON is nested deeper than 64.');
        else if (options.reportSchema) for (const m of checkSchema(report, options.reportSchema).slice(0, 5)) bad(`${m}.`);
      } catch (e) {
        bad(`Not valid JSON: ${(e as Error).message}.`);
      }
    }
  }

  // --- Pages
  const checker = new SchemaChecker(model);
  const texts = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (!/^pages\/.+\.md$/.test(path)) continue;
    const text = decode(path, bytes);
    if (text !== undefined) texts.set(path, text);
  }
  const anchors = new Map<string, Set<string>>();
  for (const [path, text] of texts) anchors.set(path.slice('pages/'.length, -'.md'.length), pageAnchors(text));
  const guideLinks: { file: string; line: number; slug: string }[] = [];
  for (const [path, text] of texts) validatePage(path, text, { model, checker, pageSlugs, assets, anchors, guideLinks, add });

  // --- Withheld pages, and links to them
  const slugOf = (file: string) => file.slice('pages/'.length, -'.md'.length);
  const withheld = [...new Set(findings.filter((f) => f.severity === 'blocker').map((f) => slugOf(f.file)))].sort(compareCodePoints);
  for (const link of guideLinks) {
    if (!withheld.includes(link.slug) || withheld.includes(slugOf(link.file))) continue;
    findings.push({ code: 'link-to-withheld-page', severity: 'warning', file: link.file, line: link.line, target: `pages/${link.slug}.md`, message: 'This link points at a page that is withheld. It will be shown as plain text.' });
  }

  const ok = !findings.some((f) => f.severity === 'error');
  return { contractVersion: CONTRACT_VERSION, ok, publishable: ok, withheld, findings };
}

interface PageContext {
  model: SpecModel;
  checker: SchemaChecker;
  pageSlugs: Set<string>;
  assets: Set<string>;
  anchors: Map<string, Set<string>>;
  guideLinks: { file: string; line: number; slug: string }[];
  add: (severity: Severity, code: string, file: string, message: string, line?: number) => void;
}

const REQUEST_CODE = /(^|[\s;&|(])(curl|wget|http(ie)?)\s+(-|https?:|\{\{|["']?https?:|(GET|POST|PUT|PATCH|DELETE)\b)|\b(fetch|axios(\.\w+)?|requests\.(get|post|put|patch|delete)|http\.request)\s*\(\s*[`"'f]*\{\{\s*base_url/im;
const EXTERNAL_LINK = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?([/?#][\x21-\x7E]*)?$/;
const TARGET_CHARS = /^(?:[A-Za-z0-9_.\-/:~@$!*+,;=]|%[0-9A-Fa-f]{2})*$/;
const TAG_LINE = /^ {0,3}<\/?[A-Z][A-Za-z0-9]*(?:\s(?:[^>"]|"[^"]*")*)?\/?>\s*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** True when the character at `i` is escaped: preceded by an odd number of backslashes. */
function escaped(line: string, i: number): boolean {
  let n = 0;
  while (i - 1 - n >= 0 && line[i - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

/** Blanks out inline code spans, matching backtick runs of equal length as CommonMark does. */
function blankCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`' || escaped(line, i)) {
      out += line[i++];
      continue;
    }
    let run = 1;
    while (line[i + run] === '`') run++;
    let j = i + run;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== '`') {
        j++;
        continue;
      }
      let r = 1;
      while (line[j + r] === '`') r++;
      if (r === run) {
        close = j;
        break;
      }
      j += r;
    }
    if (close < 0) {
      out += line.slice(i, i + run);
      i += run;
    } else {
      out += ' '.repeat(close + run - i);
      i = close + run;
    }
  }
  return out;
}

/** The values a named example supplies: the request body example and each parameter's example of that name. */
function exampleValues(op: Operation, name: string): { values: Json; found: boolean } {
  const values: Json = {};
  let found = false;
  if (op.requestBody && name in op.requestBody.examples) {
    values.body = op.requestBody.examples[name];
    found = true;
  }
  for (const p of op.parameters) {
    if (p.in === 'cookie' || !(name in p.examples)) continue;
    const group = p.in === 'path' ? 'path' : p.in === 'query' ? 'query' : 'headers';
    (values[group] ??= {})[p.name] = p.examples[name];
    found = true;
  }
  return { values, found };
}

function validatePage(file: string, text: string, ctx: PageContext): void {
  const { model, add } = ctx;
  const err = (code: string, message: string, line?: number) => add('error', code, file, message, line);
  const warn = (code: string, message: string, line?: number) => add('warning', code, file, message, line);
  const lines = text.split('\n');

  // --- Frontmatter
  let bodyStart = 0;
  if (lines[0] !== '---') err('invalid-frontmatter', 'Page must start with YAML frontmatter.', 1);
  else {
    const end = lines.indexOf('---', 1);
    if (end < 0) err('invalid-frontmatter', 'Frontmatter is not closed.', 1);
    else {
      bodyStart = end + 1;
      const source = lines.slice(1, end).join('\n');
      if (new TextEncoder().encode(lines.slice(0, end + 1).join('\n')).byteLength > 16 * 1024) err('size-limit', 'Frontmatter exceeds 16 KB.', 1);
      const doc = parseDocument(source, { uniqueKeys: true });
      let fm: Json;
      if (doc.errors.length) err('invalid-frontmatter', `Frontmatter is not valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`, 1);
      else {
        let plain = true;
        visit(doc, {
          Node(_key, node: any) {
            if (isAlias(node) || node.anchor || node.tag) plain = false;
            if (isScalar(node) && node.value !== null && typeof node.value !== 'string') plain = false;
          },
          Pair(_key, pair: any) {
            if (isScalar(pair.key) && pair.key.value === '<<') plain = false;
          },
        });
        if (!plain) err('invalid-frontmatter', 'Frontmatter must be plain YAML: text and lists of text, with no anchors, aliases, tags or merge keys.', 1);
        else fm = doc.toJS();
      }
      if (fm !== undefined) {
        if (!fm || typeof fm !== 'object' || Array.isArray(fm)) err('invalid-frontmatter', 'Frontmatter must be a mapping.', 1);
        else {
          for (const k of Object.keys(fm)) {
            if (!['title', 'description', 'type', 'status', 'operations', 'tags'].includes(k)) err('invalid-frontmatter', `Unknown frontmatter field '${k}'.`, 1);
          }
          const str = (k: string, max: number) => {
            const v = fm[k];
            if (typeof v !== 'string' || !v.trim()) err('invalid-frontmatter', `'${k}' is required and must be text.`, 1);
            else if (Array.from(v).length > max) err('invalid-frontmatter', `'${k}' is longer than ${max} characters.`, 1);
            else if (/[\r\n\u2028\u2029]/.test(v)) err('invalid-frontmatter', `'${k}' must be one line of text.`, 1);
          };
          str('title', 80);
          str('description', 200);
          if (!PAGE_TYPES.includes(fm.type)) err('invalid-frontmatter', `'type' must be one of ${PAGE_TYPES.join(', ')}.`, 1);
          if (fm.status !== undefined && !['draft', 'review', 'ready'].includes(fm.status)) err('invalid-frontmatter', "'status' must be draft, review or ready.", 1);
          if (fm.status === 'draft' || fm.status === 'review') add('blocker', 'page-not-ready', file, `This page is withheld from publishing while its status is '${fm.status}'.`, 1);
          for (const k of ['operations', 'tags']) {
            if (fm[k] !== undefined && !(Array.isArray(fm[k]) && fm[k].every((x: Json) => typeof x === 'string'))) err('invalid-frontmatter', `'${k}' must be a list of strings.`, 1);
          }
          const ops: string[] = Array.isArray(fm.operations) ? fm.operations.filter((x: Json) => typeof x === 'string') : [];
          for (const id of ops) if (!model.operationsById.has(id)) err('unknown-operation', `Operation '${id}' is not in the spec.`, 1);
          if (ops.length === 0 && ['quickstart', 'how-to', 'tutorial'].includes(fm.type)) warn('page-unreferenced', 'Page names no operations, so no reference page links back to it.', 1);
        }
      }
    }
  }

  // --- Body
  const variables = new Set(BUILTIN_VARIABLES);
  const captured = new Set<string>();
  const stack: { name: string; line: number }[] = [];
  let fence: { marker: string; lang: string; line: number; content: string[] } | undefined;
  let sample: { op?: Operation; example?: string; line: number; blocks: number; captures: [string, string][] } | undefined;
  let prevText = false;

  /** Every unescaped `{{` must begin a variable that is in scope (contract 4.6). */
  const checkVariables = (s: string, line: number) => {
    for (let at = s.indexOf('{{'); at >= 0; at = s.indexOf('{{', at + 2)) {
      if (escaped(s, at)) continue;
      const m = /^\{\{([a-z][a-z0-9_]*)\}\}/.exec(s.slice(at));
      if (!m) err('unknown-variable', "'{{' does not begin a variable. Write a literal '{{' as '\\{{'.", line);
      else if (!variables.has(m[1]!)) err('unknown-variable', `Unknown variable '{{${m[1]}}}'.`, line);
      if (m) at += m[0].length - 2;
    }
  };

  const decodeTarget = (part: string, line: number): string | undefined => {
    if (!TARGET_CHARS.test(part)) {
      err('link-not-allowed', `Link target '${part}' has a character that must be percent-encoded.`, line);
      return undefined;
    }
    try {
      return decodeURIComponent(part);
    } catch {
      err('link-not-allowed', `Link target '${part}' is not valid UTF-8 once decoded.`, line);
      return undefined;
    }
  };

  const checkTarget = (target: string, line: number, image: boolean) => {
    const m = /^(op|schema|guide|asset):([\s\S]*)$/.exec(target);
    if (image && m?.[1] !== 'asset') return err('link-not-allowed', 'An image source must be an asset: target.', line);
    if (!m) {
      if (!EXTERNAL_LINK.test(target) || target.includes('\\')) err('link-not-allowed', `Link target '${target}' is not allowed. Use op:, schema:, guide:, asset: or an https link.`, line);
      return;
    }
    const scheme = m[1]!;
    const hash = scheme === 'guide' ? m[2]!.indexOf('#') : -1;
    const id = decodeTarget(hash < 0 ? m[2]! : m[2]!.slice(0, hash), line);
    if (id === undefined) return;
    if (scheme === 'op') {
      const op = model.operationsById.get(id);
      if (!op) err('unknown-operation', `Operation '${id}' is not in the spec.`, line);
      else if (op.deprecated) warn('deprecated-operation', `Operation '${id}' is deprecated.`, line);
    } else if (scheme === 'schema') {
      if (!model.schemaNames.has(id)) err('unknown-schema', `Schema '${id}' is not in the spec.`, line);
    } else if (scheme === 'asset') {
      if (!ctx.assets.has(id)) err('unknown-asset', `Asset '${id}' is not in the bundle.`, line);
    } else {
      if (!ctx.pageSlugs.has(id)) return err('unknown-guide', `Guide '${id}' is not in the bundle.`, line);
      ctx.guideLinks.push({ file, line, slug: id });
      if (hash >= 0) {
        let anchor: string | undefined;
        try {
          anchor = decodeURIComponent(m[2]!.slice(hash + 1));
        } catch {
          anchor = undefined;
        }
        if (anchor === undefined || !ctx.anchors.get(id)?.has(anchor)) err('unknown-anchor', `Guide '${id}' has no heading with the anchor '${m[2]!.slice(hash + 1)}'.`, line);
      }
    }
  };

  const handleTag = (closing: boolean, name: string, attrText: string, selfClosing: boolean, line: number) => {
    const def = COMPONENTS[name];
    if (!def) return err('unknown-component', `Unknown component '<${name}>'.`, line);
    if (closing) {
      if (attrText.trim()) err('invalid-attribute', `Closing tag </${name}> must not have attributes.`, line);
      const top = stack.pop();
      if (!top || top.name !== name) {
        err('unbalanced-component', `</${name}> does not match ${top ? `<${top.name}> opened on line ${top.line}` : 'any open component'}.`, line);
        if (top && stack.some((s) => s.name === name)) while (stack.length && stack.pop()!.name !== name);
      }
      if (name === 'Sample' && sample) {
        if (sample.blocks !== 1) err('invalid-sample', '<Sample> with inline values must contain exactly one fenced json block.', sample.line);
        for (const [n] of sample.captures) variables.add(n);
        sample = undefined;
      }
      return;
    }
    // Attributes: name="value", double quotes always.
    const attrs: Record<string, string> = {};
    let rest = attrText;
    const re = /^\s+([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/;
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      if (m[1]! in attrs) err('invalid-attribute', `Attribute '${m[1]}' is repeated on <${name}>.`, line);
      attrs[m[1]!] = m[2]!;
      rest = rest.slice(m[0].length);
    }
    if (rest.trim()) err('invalid-attribute', `Attributes of <${name}> are written name="value" with double quotes: '${rest.trim()}'.`, line);
    for (const [k, v] of Object.entries(attrs)) {
      const a = def.attrs[k];
      if (!a) err('unknown-attribute', `Unknown attribute '${k}' on <${name}>.`, line);
      else if (a.values && !a.values.includes(v)) err('invalid-attribute', `'${k}' on <${name}> must be one of ${a.values.join(', ')}.`, line);
    }
    for (const [k, a] of Object.entries(def.attrs)) {
      if (a.required && !(k in attrs)) err('invalid-attribute', `<${name}> requires '${k}'.`, line);
    }
    const parent = stack.at(-1)?.name;
    if (def.parent && parent !== def.parent) err('invalid-nesting', `<${name}> must be directly inside <${def.parent}>.`, line);
    if (parent && COMPONENTS[parent]?.only && COMPONENTS[parent]!.only !== name) err('invalid-nesting', `<${parent}> may contain only <${COMPONENTS[parent]!.only}>.`, line);
    const closed = stack.find((s) => COMPONENTS[s.name]?.noComponents);
    if (closed) err('invalid-nesting', `<${closed.name}> takes Markdown only, not components.`, line);
    if (stack.some((s) => s.name === name)) err('invalid-nesting', `<${name}> cannot be nested inside itself.`, line);
    if (def.form === 'void' && !selfClosing) err('invalid-nesting', `<${name}> must be self-closing.`, line);
    if (def.form === 'block' && selfClosing) err('invalid-nesting', `<${name}> cannot be self-closing.`, line);
    if (name === 'Todo') add('blocker', 'todo-present', file, 'This page is withheld from publishing until its <Todo> is resolved.', line);

    const opOf = (id: string | undefined) => {
      if (id === undefined) return undefined;
      const op = model.operationsById.get(id);
      if (!op) err('unknown-operation', `Operation '${id}' is not in the spec.`, line);
      else if (op.deprecated) warn('deprecated-operation', `Operation '${id}' is deprecated.`, line);
      return op;
    };
    if (name === 'Operation') opOf(attrs.id);
    if (name === 'Schema' && attrs.ref !== undefined && !model.schemaNames.has(attrs.ref)) err('unknown-schema', `Schema '${attrs.ref}' is not in the spec.`, line);
    if (name === 'Card' && attrs.href !== undefined) checkTarget(attrs.href, line, false);
    if (name === 'Response') {
      const op = opOf(attrs.operation);
      if (op && attrs.status !== undefined && !op.responses.some((r) => r.status === attrs.status)) err('unknown-response', `Operation '${op.id}' has no '${attrs.status}' response.`, line);
    }
    if (name === 'Sample') {
      const op = opOf(attrs.operation);
      const captures = attrs.capture === undefined ? { pairs: [], bad: [] } : parseCapture(attrs.capture);
      for (const b of captures.bad) err('invalid-capture', `'${b}' is not a name=path pair. Pairs are separated by one space.`, line);
      for (const [n] of captures.pairs) {
        if (BUILTIN_VARIABLES.includes(n)) err('invalid-capture', `Capture name '${n}' is a built-in variable.`, line);
        else if (CREDENTIAL_VARIABLES.includes(n)) err('invalid-capture', `Capture name '${n}' is reserved for credentials.`, line);
        else if (captured.has(n)) err('invalid-capture', `'${n}' is captured more than once on this page.`, line);
        captured.add(n);
      }
      let example: string | undefined;
      if (op && attrs.example !== undefined) {
        if (exampleValues(op, attrs.example).found) example = attrs.example;
        else err('unknown-example', `Operation '${op.id}' has no example named '${attrs.example}'.`, line);
      }
      if (selfClosing) {
        // With no example this is the operation's default sample, valid for any operation.
        if (op && example !== undefined) for (const m of validateSampleValues(op, exampleValues(op, example).values, ctx.checker)) err('invalid-sample', m, line);
        for (const [n] of captures.pairs) variables.add(n);
      } else sample = { op, example, line, blocks: 0, captures: captures.pairs };
    }
    if (!selfClosing) {
      stack.push({ name, line });
      if (stack.length > 32) err('nesting-limit', 'Nesting is deeper than 32.', line);
    }
  };

  const blankOrTag = (i: number, allowFence: boolean) => i < bodyStart || i >= lines.length || lines[i]!.trim() === '' || TAG_LINE.test(lines[i]!) || (allowFence && FENCE_LINE.test(lines[i]!));

  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i]!;
    const n = i + 1;

    // Fenced code
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length) {
        const content = fence.content.join('\n');
        if (sample) {
          sample.blocks++;
          if (fence.lang !== 'json') err('invalid-sample', 'Inline sample values must be a fenced json block.', fence.line);
          else {
            let values: Json;
            try {
              values = JSON.parse(content);
            } catch (e) {
              err('invalid-sample', `Sample values are not valid JSON: ${(e as Error).message}`, fence.line);
            }
            if (values !== undefined && jsonDepth(values) > 64) {
              err('invalid-sample', 'Sample values are nested deeper than 64.', fence.line);
              values = undefined;
            }
            const op = sample.op;
            if (values !== undefined && op) {
              let merged = values;
              if (sample.example !== undefined && values && typeof values === 'object' && !Array.isArray(values)) {
                const ex = exampleValues(op, sample.example).values;
                if ('body' in ex && 'body' in values) err('invalid-sample', 'The named example supplies the request body, so the inline block cannot have one.', fence.line);
                merged = { ...ex, ...values };
                for (const k of ['path', 'query', 'headers']) if (ex[k] || values[k]) merged[k] = { ...ex[k], ...values[k] };
              }
              for (const m of validateSampleValues(op, merged, ctx.checker)) err('invalid-sample', m, fence.line);
              for (const m of undeclaredParameters(op, merged)) warn('undeclared-parameter', m, fence.line);
            }
          }
        } else {
          if (REQUEST_CODE.test(content) || /(^|[^\\])\{\{base_url\}\}/.test(content)) warn('api-request-code', 'Code block looks like a hand-written API request. Use <Sample> instead.', fence.line);
        }
        fence = undefined;
      } else {
        fence.content.push(raw);
        checkVariables(raw, n);
      }
      continue;
    }
    if (/^\s+(>\s*|[-*+]\s+|\d+[.)]\s+)*(`{3,}|~{3,})/.test(raw) || /^(>\s*|[-*+]\s+|\d+[.)]\s+)+(`{3,}|~{3,})/.test(raw)) {
      err('unsupported-syntax', 'Code blocks must start at the left margin, outside lists and quotes, so they can be checked.', n);
      continue;
    }
    const open = /^(`{3,}|~{3,})\s*(.*)$/.exec(raw);
    if (open) {
      const info = open[2]!.trim();
      const m = /^(?:([A-Za-z0-9_+#.-]+)((?: (?:title|highlight)="[^"]*"){0,2}))?$/.exec(info);
      if (!m) err('invalid-code-info', `Code block info string '${info}' is not a language followed by title="…" or highlight="…".`, n);
      else {
        const hl = /highlight="([^"]*)"/.exec(m[2] ?? '');
        if (hl && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(hl[1]!)) err('invalid-code-info', `highlight '${hl[1]}' is not a list of lines or ranges.`, n);
      }
      fence = { marker: open[1]!, lang: m?.[1] ?? '', line: n, content: [] };
      prevText = false;
      continue;
    }

    // Prose. Inline code spans are opaque: no tag, link or variable is recognised in one.
    const line = blankCodeSpans(raw);
    if (sample && line.trim() && !/^\s*<\/Sample>\s*$/.test(line)) err('invalid-sample', 'A <Sample> may contain only one fenced json block.', n);
    const inner = line.replace(/^(\s*(>|[-*+](?=\s)|\d+[.)](?=\s)))+/, '');
    if (/^\s*#(\s|$)/.test(inner)) err('heading-h1', 'The body must not contain an h1. Headings start at h2.', n);
    if (/^\s*=+\s*$/.test(inner) && prevText) err('heading-h1', 'The body must not contain an h1. Headings start at h2.', n);
    prevText = raw.trim() !== '';

    // Tags, raw HTML and autolinks
    let tags = 0;
    for (let at = line.indexOf('<'); at >= 0; at = line.indexOf('<', at + 1)) {
      if (escaped(line, at)) continue;
      const rest = line.slice(at);
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])((?:[^>"]|"[^"]*")*?)(\/?)>/.exec(rest);
      if (tag) {
        const name = tag[2]!;
        if (/^[A-Z]/.test(name)) {
          tags++;
          handleTag(tag[1] === '/', name, tag[3]!, tag[4] === '/', n);
        } else err('disallowed-syntax', `Raw HTML is not allowed: <${tag[1]}${name}>.`, n);
        at += tag[0].length - 1;
      } else if (/^<([a-z][a-z0-9+.-]*:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/i.test(rest)) {
        err('disallowed-syntax', 'Autolinks in angle brackets are not allowed. Write [text](https://…).', n);
      } else if (/^<[A-Za-z/!?]/.test(rest)) {
        err('disallowed-syntax', 'Raw HTML or an incomplete tag. Component tags must fit on one line.', n);
      }
    }
    if (tags > 0) {
      const closingSample = /^\s*<\/Sample>/.test(raw);
      const openingSample = /^\s*<Sample\b/.test(raw) && !/\/>\s*$/.test(raw);
      if (tags > 1 || !TAG_LINE.test(raw)) err('invalid-tag-placement', 'A component tag is alone on its line, indented by at most 3 spaces, and not inside a list, quote or table.', n);
      else if (!blankOrTag(i - 1, closingSample) || !blankOrTag(i + 1, openingSample)) err('invalid-tag-placement', 'A component tag has a blank line or another tag before and after it.', n);
    }

    // Variables. They are not recognised in component attributes, so a tag line is skipped.
    if (!(tags > 0 && TAG_LINE.test(raw))) checkVariables(line, n);

    // Links and images
    for (let at = line.indexOf(']('); at >= 0; at = line.indexOf('](', at + 1)) {
      if (escaped(line, at)) continue;
      const dest = /^\s*(?:(<[^>]*>)|([^\s)]*))/.exec(line.slice(at + 2))!;
      const target = dest[1] ?? dest[2] ?? '';
      // Find the opening bracket to tell an image from a link.
      let depth = 0;
      let start = -1;
      for (let k = at - 1; k >= 0; k--) {
        if (line[k] === ']' && !escaped(line, k)) depth++;
        else if (line[k] === '[' && !escaped(line, k)) {
          if (depth === 0) {
            start = k;
            break;
          }
          depth--;
        }
      }
      const image = start > 0 && line[start - 1] === '!';
      if (!target) err('link-not-allowed', 'A link destination must follow on the same line.', n);
      else if (dest[1]) err('link-not-allowed', 'A link destination in angle brackets is not allowed.', n);
      else checkTarget(target, n, image);
      if (image && !line.slice(start + 1, at).trim()) warn('image-missing-alt', 'Image has no alt text.', n);
    }
    const def = /^\s*(?:>\s*)*\[(?!\^)[^\]]+\]:\s*(\S*)/.exec(line);
    if (def) {
      if (!def[1]) err('link-not-allowed', 'A link definition must have its destination on the same line.', n);
      else if (def[1].startsWith('<')) err('link-not-allowed', 'A link destination in angle brackets is not allowed.', n);
      else checkTarget(def[1], n, false);
    }
  }

  if (fence) err('unsupported-syntax', 'Code block is not closed.', fence.line);
  for (const s of stack) err('unbalanced-component', `<${s.name}> is not closed.`, s.line);
}

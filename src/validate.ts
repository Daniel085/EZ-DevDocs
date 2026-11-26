// Validates a guides bundle against the guides contract (v0.1) before it leaves this module.
// Pure: takes the bundle's files in memory and the spec model.

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import type { Json, SpecModel } from './spec.ts';
import { SchemaChecker, validateSampleValues } from './values.ts';

const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: any) => void;

export interface Finding {
  code: string;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
}

export type BundleFiles = Map<string, Uint8Array>;

export const CONTRACT_VERSION = '0.1';
export const BUILTIN_VARIABLES = ['base_url', 'api_key', 'idempotency_key', 'api_name'];
const PAGE_TYPES = ['quickstart', 'concept', 'how-to', 'tutorial', 'reference'];
const ASSET_TYPES = ['png', 'jpg', 'webp', 'gif', 'svg', 'pdf', 'json', 'zip'];
const MB = 1024 * 1024;

interface ComponentDef {
  attrs: Record<string, { required?: boolean; values?: string[] }>;
  parent?: string;
  /** 'void' must self-close, 'block' must not, 'either' may do both. */
  form: 'void' | 'block' | 'either';
}

export const COMPONENTS: Record<string, ComponentDef> = {
  Callout: { attrs: { type: { required: true, values: ['note', 'tip', 'warning', 'danger'] }, title: {} }, form: 'block' },
  Steps: { attrs: {}, form: 'block' },
  Step: { attrs: { title: { required: true } }, parent: 'Steps', form: 'block' },
  Tabs: { attrs: {}, form: 'block' },
  Tab: { attrs: { title: { required: true } }, parent: 'Tabs', form: 'block' },
  CardGroup: { attrs: { cols: {} }, form: 'block' },
  Card: { attrs: { title: { required: true }, href: { required: true } }, parent: 'CardGroup', form: 'either' },
  Operation: { attrs: { id: { required: true } }, form: 'void' },
  Schema: { attrs: { ref: { required: true } }, form: 'void' },
  Sample: { attrs: { operation: { required: true }, example: {}, title: {}, capture: {} }, form: 'either' },
  Response: { attrs: { operation: { required: true }, status: { required: true } }, form: 'void' },
};

const CAPTURE = /^([a-z][a-z0-9_]*)=(\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\]|\['[^']+'\])*)$/;

/** Parses a `capture` attribute into name/JSONPath pairs. Pairs are separated by commas or spaces. */
export function parseCapture(value: string): { pairs: [string, string][]; bad: string[] } {
  const pairs: [string, string][] = [];
  const bad: string[] = [];
  for (const part of value.split(/[\s,]+/).filter(Boolean)) {
    const m = CAPTURE.exec(part);
    if (m) pairs.push([m[1]!, m[2]!]);
    else bad.push(part);
  }
  return { pairs, bad };
}

let manifestValidator: ((v: Json) => boolean) | undefined;

function checkManifestSchema(manifest: Json, schema: Json): string[] {
  if (!manifestValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    manifestValidator = ajv.compile(schema);
  }
  if (manifestValidator(manifest)) return [];
  return ((manifestValidator as any).errors ?? []).map((e: Json) => `${e.instancePath || '/'} ${e.message}`);
}

export interface ValidateOptions {
  manifestSchema: Json;
  /** Hash of the spec the portal is publishing, when known. A mismatch is a warning. */
  publishedSpecSha256?: string;
}

export function validateBundle(files: BundleFiles, model: SpecModel, options: ValidateOptions): ValidationReport {
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, file: string, message: string, line?: number) =>
    findings.push(line === undefined ? { code, severity, file, message } : { code, severity, file, line, message });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (file: string, bytes: Uint8Array): string | undefined => {
    try {
      const text = decoder.decode(bytes);
      if (text.includes('\r')) add('error', 'invalid-encoding', file, 'Line endings must be LF.');
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
    if (path === 'guides.json') continue;
    const page = /^pages\/(.+)\.md$/.exec(path);
    const asset = /^assets\/(.+)$/.exec(path);
    if (!page && !asset) {
      add('error', 'unexpected-file', path, 'Only guides.json, pages/*.md and assets/* belong in a bundle.');
      continue;
    }
    const stem = page ? page[1]! : asset![1]!.replace(/\.[a-z0-9]+$/, '');
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(stem)) add('error', 'invalid-path', path, 'Paths are lowercase and use only a-z, 0-9, - and /.');
    if (page) {
      pageSlugs.add(page[1]!);
      if (bytes.byteLength > 2 * MB) add('error', 'size-limit', path, 'Page exceeds 2 MB.');
    } else {
      assets.add(asset![1]!);
      const ext = /\.([a-z0-9]+)$/.exec(path)?.[1] ?? '';
      if (!ASSET_TYPES.includes(ext)) add('error', 'asset-type', path, `Asset type '${ext}' is not allowed.`);
      if (bytes.byteLength > 5 * MB) add('error', 'size-limit', path, 'Asset exceeds 5 MB.');
    }
  }
  if (total > 200 * MB) add('error', 'size-limit', 'guides.json', 'Bundle exceeds 200 MB.');

  // --- Manifest
  const navPages = new Map<string, number>();
  const manifestBytes = files.get('guides.json');
  if (!manifestBytes) add('error', 'missing-manifest', 'guides.json', 'The bundle has no guides.json.');
  else {
    const text = decode('guides.json', manifestBytes);
    let manifest: Json;
    try {
      manifest = text === undefined ? undefined : JSON.parse(text);
    } catch (e) {
      add('error', 'invalid-manifest', 'guides.json', `Not valid JSON: ${(e as Error).message}`);
    }
    if (manifest !== undefined) {
      for (const m of checkManifestSchema(manifest, options.manifestSchema)) add('error', 'invalid-manifest', 'guides.json', m);
      const walk = (items: Json, depth: number) => {
        for (const item of Array.isArray(items) ? items : []) {
          if (typeof item?.page === 'string') navPages.set(item.page, (navPages.get(item.page) ?? 0) + 1);
          else if (item && Array.isArray(item.items)) {
            if (depth + 1 > 3) add('error', 'nav-depth', 'guides.json', `Group '${item.group}' nests deeper than 3 levels.`);
            walk(item.items, depth + 1);
          }
        }
      };
      walk(manifest.nav, 0);
      for (const [slug, count] of navPages) {
        if (count > 1) add('error', 'duplicate-page', 'guides.json', `Page '${slug}' appears in nav ${count} times.`);
        if (!pageSlugs.has(slug)) add('error', 'missing-page', 'guides.json', `Nav refers to page '${slug}', which has no file.`);
      }
      for (const slug of pageSlugs) {
        if (!navPages.has(slug)) add('error', 'missing-page', `pages/${slug}.md`, 'Page file is not listed in nav.');
      }
      const major = String(manifest.contractVersion ?? '').split('.')[0];
      if (major !== CONTRACT_VERSION.split('.')[0]) add('error', 'unsupported-contract-version', 'guides.json', `Contract version '${manifest.contractVersion}' is not supported.`);
      const hash = manifest.spec?.sha256;
      if (typeof hash === 'string' && hash !== model.sha256) add('warning', 'spec-hash-mismatch', 'guides.json', 'spec.sha256 differs from the spec the bundle is being checked against.');
      if (options.publishedSpecSha256 && hash !== options.publishedSpecSha256) add('warning', 'spec-hash-mismatch', 'guides.json', 'spec.sha256 differs from the published spec.');
    }
  }

  // --- Pages
  const checker = new SchemaChecker(model);
  for (const [path, bytes] of files) {
    if (!/^pages\/.+\.md$/.test(path)) continue;
    const text = decode(path, bytes);
    if (text !== undefined) validatePage(path, text, { model, checker, pageSlugs, assets, add });
  }

  const errors = findings.filter((f) => f.severity === 'error');
  return { ok: errors.length === 0, errors, warnings: findings.filter((f) => f.severity === 'warning') };
}

interface PageContext {
  model: SpecModel;
  checker: SchemaChecker;
  pageSlugs: Set<string>;
  assets: Set<string>;
  add: (severity: Finding['severity'], code: string, file: string, message: string, line?: number) => void;
}

const REQUEST_CODE = /(^|[\s;&|(])(curl|wget|http(ie)?)\s+(-|https?:|\{\{|["']?https?:|(GET|POST|PUT|PATCH|DELETE)\b)|\b(fetch|axios(\.\w+)?|requests\.(get|post|put|patch|delete)|http\.request)\s*\(\s*[`"'f]*\{\{\s*base_url/im;

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
      let fm: Json;
      try {
        fm = parseYaml(lines.slice(1, end).join('\n'));
      } catch (e) {
        err('invalid-frontmatter', `Frontmatter is not valid YAML: ${(e as Error).message}`, 1);
      }
      if (fm !== undefined) {
        if (!fm || typeof fm !== 'object' || Array.isArray(fm)) err('invalid-frontmatter', 'Frontmatter must be a mapping.', 1);
        else {
          for (const k of Object.keys(fm)) {
            if (!['title', 'description', 'type', 'operations', 'tags'].includes(k)) err('invalid-frontmatter', `Unknown frontmatter field '${k}'.`, 1);
          }
          const str = (k: string, max: number) => {
            const v = fm[k];
            if (typeof v !== 'string' || !v.trim()) err('invalid-frontmatter', `'${k}' is required and must be text.`, 1);
            else if (v.length > max) err('invalid-frontmatter', `'${k}' is longer than ${max} characters.`, 1);
            else if (/[<>{}\n]/.test(v)) err('invalid-frontmatter', `'${k}' must be plain text.`, 1);
          };
          str('title', 80);
          str('description', 200);
          if (!PAGE_TYPES.includes(fm.type)) err('invalid-frontmatter', `'type' must be one of ${PAGE_TYPES.join(', ')}.`, 1);
          for (const k of ['operations', 'tags']) {
            if (fm[k] !== undefined && !(Array.isArray(fm[k]) && fm[k].every((x: Json) => typeof x === 'string'))) err('invalid-frontmatter', `'${k}' must be a list of strings.`, 1);
          }
          const ops: string[] = Array.isArray(fm.operations) ? fm.operations.filter((x: Json) => typeof x === 'string') : [];
          for (const id of ops) if (!model.operationsById.has(id)) err('unknown-operation', `Operation '${id}' is not in the spec.`, 1);
          if (ops.length === 0) warn('page-unreferenced', 'Page is not referenced by any operation.', 1);
        }
      }
    }
  }

  // --- Body
  const variables = new Set(BUILTIN_VARIABLES);
  const stack: { name: string; line: number }[] = [];
  let fence: { marker: string; lang: string; line: number; content: string[] } | undefined;
  let sample: { operation?: string; line: number; blocks: number; captures: [string, string][] } | undefined;
  let prevText = false;

  const checkVariables = (s: string, line: number) => {
    for (const m of s.matchAll(/(\\?)\{\{([^{}]*)\}\}/g)) {
      if (m[1]) continue;
      const name = m[2]!.trim();
      if (!variables.has(name)) err('unknown-variable', `Unknown variable '{{${name}}}'.`, line);
    }
  };

  const checkTarget = (target: string, line: number, image: boolean) => {
    const [scheme, rest = ''] = target.includes(':') ? [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)] : ['', target];
    if (scheme === 'op') {
      if (!model.operationsById.has(rest)) err('unknown-operation', `Operation '${rest}' is not in the spec.`, line);
    } else if (scheme === 'schema') {
      if (!model.schemaNames.has(rest)) err('unknown-schema', `Schema '${rest}' is not in the spec.`, line);
    } else if (scheme === 'guide') {
      const slug = rest.split('#')[0]!;
      if (!ctx.pageSlugs.has(slug)) err('unknown-guide', `Guide '${slug}' is not in the bundle.`, line);
    } else if (scheme === 'asset') {
      if (!ctx.assets.has(rest)) err('unknown-asset', `Asset '${rest}' is not in the bundle.`, line);
    } else if (scheme !== 'https' || !/^\/\/[^\s/]+/.test(rest)) {
      err('link-not-allowed', `Link target '${target}' is not allowed. Use op:, schema:, guide:, asset: or https links.`, line);
    }
    if (image && scheme !== 'asset' && scheme !== 'https') err('link-not-allowed', 'Image sources must be asset: or https.', line);
  };

  const handleTag = (closing: boolean, name: string, attrText: string, selfClosing: boolean, line: number) => {
    const def = COMPONENTS[name];
    if (!def) return err('unknown-component', `Unknown component '<${name}>'.`, line);
    if (closing) {
      if (attrText.trim()) err('disallowed-syntax', `Closing tag </${name}> must not have attributes.`, line);
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
    // Attributes
    const attrs: Record<string, string> = {};
    let rest = attrText;
    const re = /^\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|(\d+(?:\.\d+)?|true|false)(?=\s|$))/;
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      if (m[1]! in attrs) err('unknown-attribute', `Attribute '${m[1]}' is repeated on <${name}>.`, line);
      attrs[m[1]!] = m[2] ?? m[3]!;
      rest = rest.slice(m[0].length);
    }
    if (rest.trim()) err('disallowed-syntax', `Attributes of <${name}> must be literal values in double quotes: '${rest.trim()}'.`, line);
    for (const [k, v] of Object.entries(attrs)) {
      const a = def.attrs[k];
      if (!a) err('unknown-attribute', `Unknown attribute '${k}' on <${name}>.`, line);
      else if (a.values && !a.values.includes(v)) err('invalid-attribute', `'${k}' on <${name}> must be one of ${a.values.join(', ')}.`, line);
    }
    for (const [k, a] of Object.entries(def.attrs)) {
      if (a.required && !(k in attrs)) err('invalid-attribute', `<${name}> requires '${k}'.`, line);
    }
    if (def.parent && stack.at(-1)?.name !== def.parent) err('invalid-nesting', `<${name}> must be directly inside <${def.parent}>.`, line);
    if (def.form === 'void' && !selfClosing) err('invalid-nesting', `<${name}> must be self-closing.`, line);
    if (def.form === 'block' && selfClosing) err('invalid-nesting', `<${name}> cannot be self-closing.`, line);

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
    if (name === 'CardGroup' && attrs.cols !== undefined && !/^[1-4]$/.test(attrs.cols)) err('invalid-attribute', "'cols' must be a number from 1 to 4.", line);
    if (name === 'Response') {
      const op = opOf(attrs.operation);
      if (op && attrs.status !== undefined && !op.responses.some((r) => r.status === attrs.status)) err('unknown-response', `Operation '${op.id}' has no '${attrs.status}' response.`, line);
    }
    if (name === 'Sample') {
      const op = opOf(attrs.operation);
      const captures = attrs.capture === undefined ? { pairs: [], bad: [] } : parseCapture(attrs.capture);
      for (const b of captures.bad) err('invalid-capture', `'${b}' is not a name=JSONPath pair.`, line);
      for (const [n] of captures.pairs) if (BUILTIN_VARIABLES.includes(n)) err('invalid-capture', `Capture name '${n}' is a built-in variable.`, line);
      if (op && attrs.example !== undefined) {
        const known = attrs.example in (op.requestBody?.examples ?? {}) || op.parameters.some((p) => attrs.example! in p.examples);
        if (!known) err('unknown-example', `Operation '${op.id}' has no example named '${attrs.example}'.`, line);
        if (!selfClosing) err('invalid-sample', 'A <Sample> takes a named example or inline values, not both.', line);
      }
      if (selfClosing) {
        if (op && attrs.example === undefined) {
          for (const m of validateSampleValues(op, {}, ctx.checker)) err('invalid-sample', m, line);
        }
        for (const [n] of captures.pairs) variables.add(n);
      } else sample = { operation: op?.id, line, blocks: 0, captures: captures.pairs };
    }
    if (!selfClosing) stack.push({ name, line });
  };

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
            const op = sample.operation ? model.operationsById.get(sample.operation) : undefined;
            if (values !== undefined && op) for (const m of validateSampleValues(op, values, ctx.checker)) err('invalid-sample', m, fence.line);
          }
        } else if (REQUEST_CODE.test(content)) {
          err('api-request-code', 'Code block looks like a hand-written API request. Use <Sample> instead.', fence.line);
        }
        fence = undefined;
      } else {
        fence.content.push(raw);
        checkVariables(raw, n);
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(raw);
    if (open) {
      const info = open[2]!.trim();
      const m = /^([A-Za-z0-9_+#.-]*)((?:\s+(?:title|highlight)="[^"]*")*)$/.exec(info);
      if (!m) err('invalid-code-info', `Code block info string '${info}' is not a language followed by title="…" or highlight="…".`, n);
      else {
        const hl = /highlight="([^"]*)"/.exec(m[2]!);
        if (hl && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(hl[1]!)) err('invalid-code-info', `highlight '${hl[1]}' is not a list of lines or ranges.`, n);
      }
      fence = { marker: open[1]!, lang: m?.[1] ?? '', line: n, content: [] };
      prevText = false;
      continue;
    }

    // Prose. Inline code spans are opaque.
    const line = raw.replace(/(`+)(.+?)\1/g, (s) => ' '.repeat(s.length));
    if (sample && line.trim() && !/^\s*<\/Sample>\s*$/.test(line)) err('invalid-sample', 'A <Sample> may contain only one fenced json block.', n);
    if (/^ {0,3}#(\s|$)/.test(line)) err('heading-h1', 'The body must not contain an h1. Headings start at h2.', n);
    if (/^ {0,3}=+\s*$/.test(line) && prevText) err('heading-h1', 'The body must not contain an h1. Headings start at h2.', n);
    if (/^(import|export)\s/.test(line)) err('disallowed-syntax', 'import and export statements are not allowed.', n);
    prevText = line.trim() !== '' && !/^ {0,3}(#|>|[-*+]\s|\d+\.\s|<)/.test(line);

    // Tags and raw HTML
    for (let at = line.indexOf('<'); at >= 0; at = line.indexOf('<', at + 1)) {
      if (line[at - 1] === '\\') continue;
      const rest = line.slice(at);
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])([^>]*?)(\/?)>/.exec(rest);
      if (tag) {
        const name = tag[2]!;
        if (/^[A-Z]/.test(name)) handleTag(tag[1] === '/', name, tag[3]!, tag[4] === '/', n);
        else err('disallowed-syntax', `Raw HTML is not allowed: <${tag[1]}${name}>.`, n);
        at += tag[0].length - 1;
      } else if (/^<https:\/\/[^\s<>]+>/.test(rest)) {
        // An https autolink.
      } else if (/^<[a-z][a-z0-9+.-]*:[^\s<>]*>/i.test(rest)) {
        err('link-not-allowed', 'Only https links are allowed.', n);
      } else if (/^<[A-Za-z/!?]/.test(rest)) {
        err('disallowed-syntax', 'Raw HTML or an incomplete tag. Component tags must fit on one line.', n);
      }
    }

    // Variables and stray braces
    checkVariables(line, n);
    if (/\{/.test(line.replace(/\\?\{\{[^{}]*\}\}/g, '').replace(/\\\{/g, ''))) err('disallowed-syntax', 'JSX expressions are not allowed. Write a literal brace as \\{.', n);

    // Links and images
    for (const m of line.matchAll(/(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g)) {
      if (line[m.index! - 1] === '\\') continue;
      checkTarget(m[3]!, n, m[1] === '!');
      if (m[1] === '!' && !m[2]!.trim()) warn('image-missing-alt', 'Image has no alt text.', n);
    }
    const def = /^ {0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (def) checkTarget(def[1]!.replace(/^<|>$/g, ''), n, false);
  }

  if (fence) err('disallowed-syntax', 'Code block is not closed.', fence.line);
  for (const s of stack) err('unbalanced-component', `<${s.name}> is not closed.`, s.line);
}

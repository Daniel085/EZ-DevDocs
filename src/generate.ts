// Orchestrates a run: analyze the spec, build pages, assemble the bundle, validate it, report.
// Pure: returns the bundle's files in memory. Writing them is the caller's job.

import { findResources } from './analyze.ts';
import { auditSpec, renderAudit, type AuditFinding } from './audit.ts';
import {
  authenticationPage,
  errorsPage,
  idempotencyPage,
  isPage,
  nestedTutorial,
  paginationPage,
  quickstartPage,
  rateLimitsPage,
  resourcePage,
  webhooksPage,
  type Ctx,
  type Page,
  type Result,
  type Skipped,
} from './pages.ts';
import { compareCodePoints, loadSpec, sha256, type Json } from './spec.ts';
import { CONTRACT_VERSION, validateBundle, type BundleFiles, type Finding, type ValidationReport } from './validate.ts';
import { SchemaChecker } from './values.ts';

export const GENERATOR = { name: 'ez-devdocs', version: '0.2.0' };

export interface GenerateOptions {
  manifestSchema: Json;
  /** Schema of `report.json`, so the report is checked like the rest of the bundle. */
  reportSchema?: Json;
  /** ISO 8601 timestamp for the manifest. Left out by default, so output is byte-identical across runs. */
  generatedAt?: string;
  /**
   * The bundle as it stands where people edit it. A page a person changed since this module wrote
   * it is emitted byte for byte as given; so is a page a person added, and a navigation they edited.
   */
  existing?: BundleFiles;
}

export interface ReportPage {
  page: string;
  outcome: 'written' | 'skipped';
  reason?: string;
  /** True when sample values on the page were built from types because the spec had no examples. */
  placeholderValues?: boolean;
  type?: string;
  title?: string;
  operations?: string[];
  /** SHA-256 of the page as this module wrote it. A page whose bytes differ later was edited by a person. */
  sha256?: string;
  /** 'edited': the page was taken from the existing bundle as a person left it, not generated. */
  kept?: 'edited';
  /** On a kept page: why the generator itself would no longer write this page. */
  generatorSkipped?: string;
}

export interface SpecProblem extends Omit<AuditFinding, 'subjects'> {
  /** The finding in one line, as the contract's report shape requires. */
  message: string;
  /** Affected operation ids or other subjects, at most 200. */
  subjects: string[];
  subjectsOmitted?: number;
}

/** `report.json`: the contract's shape (pages, gaps, specProblems) with this module's detail as extra members. */
export interface RunReport {
  generator: typeof GENERATOR;
  contractVersion: string;
  spec: { title: string; version: string; openapi: string; sha256: string; operations: number };
  pages: ReportPage[];
  /** What the spec did not say, and edited pages that no longer fit it. A person should complete these. */
  gaps: { page?: string; message: string }[];
  /** What the owner of the spec should fix, most serious first. */
  specProblems: SpecProblem[];
  /** SHA-256 of the navigation as this module wrote it. Absent when a person's navigation was kept. */
  navSha256?: string;
  /** Entries left out to stay inside the report's limits. */
  omitted?: { pages?: number; gaps?: number };
}

export interface GenerateResult {
  /** The bundle: guides.json, report.json, pages and any assets carried over. */
  files: BundleFiles;
  manifest: Json;
  report: RunReport;
  validation: ValidationReport;
  /** The spec audit as Markdown, for the owner of the spec. Not part of the bundle. */
  auditMarkdown: string;
}

function build(ctx: Ctx): Result[] {
  const results: Result[] = [quickstartPage(ctx), authenticationPage(ctx), errorsPage(ctx), paginationPage(ctx), idempotencyPage(ctx), rateLimitsPage(ctx), webhooksPage(ctx)];
  for (const r of ctx.resources) if (r.itemPath) results.push(resourcePage(ctx, r));
  for (const child of ctx.resources) {
    if (!child.create || child.parentParams.length !== 1 || !(child.itemPath || child.list)) continue;
    const parent = ctx.resources.find((p) => p.itemPath !== undefined && child.collectionPath.startsWith(p.itemPath + '/') && !child.collectionPath.slice(p.itemPath.length + 1).includes('/'));
    if (parent && parent.parentParams.length === 0 && parent.create) results.push(nestedTutorial(ctx, parent, child));
  }
  return results;
}

const GROUPS: Record<string, string> = { concept: 'Concepts', 'how-to': 'Guides', tutorial: 'Tutorials', reference: 'Reference' };

interface OutPage {
  slug: string;
  type: string;
  bytes: Uint8Array;
}

/** Navigation as this module orders it: the quickstart, then one group per page type. */
function freshNav(pages: OutPage[]): Json[] {
  const entry = (p: OutPage) => ({ page: p.slug });
  const nav: Json[] = pages.filter((p) => p.type === 'quickstart').map(entry);
  for (const [type, group] of Object.entries(GROUPS)) {
    const items = pages.filter((p) => p.type === type).map(entry);
    if (items.length) nav.push({ group, items });
  }
  return nav;
}

/** A person's navigation, kept: entries for pages that are gone are removed, new pages are added. */
function mergeNav(existing: Json, pages: OutPage[]): Json[] {
  const have = new Set(pages.map((p) => p.slug));
  const seen = new Set<string>();
  const prune = (items: Json): Json[] => {
    const out: Json[] = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (typeof item?.page === 'string') {
        if (have.has(item.page) && !seen.has(item.page)) {
          seen.add(item.page);
          out.push(item);
        }
      } else if (item && Array.isArray(item.items)) {
        const inner = prune(item.items);
        if (inner.length) out.push({ ...item, items: inner });
      }
    }
    return out;
  };
  const nav = prune(existing);
  for (const p of pages) {
    if (seen.has(p.slug)) continue;
    const entry = { page: p.slug };
    const group = GROUPS[p.type];
    if (!group) nav.unshift(entry);
    else {
      const at = nav.find((x) => x.group === group && Array.isArray(x.items));
      if (at) at.items = [...at.items, entry];
      else nav.push({ group, items: [entry] });
    }
  }
  return nav;
}

function assemble(pages: OutPage[], nav: Json[], assets: [string, Uint8Array][], model: ReturnType<typeof loadSpec>, options: GenerateOptions): { files: BundleFiles; manifest: Json } {
  const files: BundleFiles = new Map();
  const manifest: Json = {
    contractVersion: CONTRACT_VERSION,
    generator: GENERATOR,
    spec: { sha256: model.sha256, title: model.title, version: model.version },
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    nav,
  };
  files.set('guides.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
  for (const p of pages) files.set(`pages/${p.slug}.md`, p.bytes);
  for (const [path, bytes] of assets) files.set(path, bytes);
  return { files, manifest };
}

const enc = new TextEncoder();

/** What the existing bundle says about itself: its pages, and which of them a person has changed. */
function readExisting(existing: BundleFiles | undefined) {
  const pages = new Map<string, Uint8Array>();
  const assets: [string, Uint8Array][] = [];
  let nav: Json;
  let navIsOurs = false;
  const recorded = new Map<string, string>();
  if (existing) {
    const json = (path: string): Json => {
      try {
        return JSON.parse(new TextDecoder().decode(existing.get(path)));
      } catch {
        return undefined;
      }
    };
    const report = existing.has('report.json') ? json('report.json') : undefined;
    for (const p of Array.isArray(report?.pages) ? report.pages : []) if (typeof p?.page === 'string' && typeof p.sha256 === 'string') recorded.set(p.page, p.sha256);
    const manifest = existing.has('guides.json') ? json('guides.json') : undefined;
    if (Array.isArray(manifest?.nav)) {
      nav = manifest.nav;
      navIsOurs = typeof report?.navSha256 === 'string' && report.navSha256 === sha256(JSON.stringify(nav));
    }
    for (const [path, bytes] of [...existing].sort(([a], [b]) => compareCodePoints(a, b))) {
      const m = /^pages\/(.+)\.md$/.exec(path);
      if (m) pages.set(m[1]!, bytes);
      else if (path.startsWith('assets/')) assets.push([path, bytes]);
    }
  }
  /** Pages a person edited or added: anything this module has no record of writing in exactly this form. */
  const kept = new Map<string, Uint8Array>();
  for (const [slug, bytes] of pages) if (recorded.get(slug) !== sha256(bytes)) kept.set(slug, bytes);
  return { kept, assets, nav, navIsOurs };
}

const typeOfPage = (bytes: Uint8Array): string => /^type:\s*["']?([a-z-]+)["']?\s*$/m.exec(new TextDecoder().decode(bytes).split('\n---')[0] ?? '')?.[1] ?? 'how-to';

export class GenerationError extends Error {}

export function generate(spec: string | Uint8Array, options: GenerateOptions): GenerateResult {
  const model = loadSpec(spec);
  const checker = new SchemaChecker(model);
  const resources = findResources(model);
  const prev = readExisting(options.existing);
  const validate = (files: BundleFiles) => validateBundle(files, model, { manifestSchema: options.manifestSchema, reportSchema: options.reportSchema });
  const slugOf = (f: Finding) => /^pages\/(.+)\.md$/.exec(f.file)?.[1];

  // Pages link to each other, so a page that fails validation must be dropped before the others
  // are written. Build once assuming every page exists, then again knowing which ones do. A page
  // a person edited is never dropped or rewritten: it stands in for the generated one.
  const dropped = new Map<string, string>();
  let pages: Page[] = [];
  let skipped: Skipped[] = [];
  let out: OutPage[] = [];
  let bundle: ReturnType<typeof assemble> | undefined;
  let validation: ValidationReport | undefined;
  let exists: Set<string> | undefined;
  let navKept = false;
  for (let round = 0; round < 6; round++) {
    const results = build({ model, checker, resources, has: (slug) => prev.kept.has(slug) || ((exists ? exists.has(slug) : true) && !dropped.has(slug)) });
    pages = results.filter(isPage).filter((p) => !dropped.has(p.slug));
    skipped = results.filter((r): r is Skipped => !isPage(r));
    if (pages.length === 0 && prev.kept.size === 0) break;
    if (!exists) {
      exists = new Set(pages.map((p) => p.slug));
      continue;
    }
    out = pages.map((p) => ({ slug: p.slug, type: p.type, bytes: prev.kept.get(p.slug) ?? enc.encode(p.body) }));
    const generated = new Set(pages.map((p) => p.slug));
    for (const [slug, bytes] of prev.kept) if (!generated.has(slug)) out.push({ slug, type: typeOfPage(bytes), bytes });
    navKept = prev.nav !== undefined && !prev.navIsOurs;
    bundle = assemble(out, navKept ? mergeNav(prev.nav, out) : freshNav(out), prev.assets, model, options);
    validation = validate(bundle.files);
    const before = dropped.size;
    for (const f of validation.findings) {
      // Stricter with its own output than the contract: request code in a generated page is dropped.
      if (f.severity !== 'error' && f.code !== 'api-request-code') continue;
      const slug = slugOf(f);
      if (slug && !prev.kept.has(slug) && !dropped.has(slug)) dropped.set(slug, `${f.code}: ${f.message}`);
    }
    if (dropped.size === before) break;
  }
  if (!bundle || !validation || out.length === 0) {
    throw new GenerationError('No guide could be generated from this specification: ' + (skipped.map((s) => `${s.page} (${s.reason})`).join('; ') || 'it has no operations'));
  }
  for (const [slug, why] of dropped) skipped.push({ page: slug, reason: `generated page failed contract validation and was left out (${why})` });

  // --- The run report, which is part of the bundle
  const audit = auditSpec(model);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const skipReason = new Map(skipped.map((s) => [s.page, s.reason]));
  const reportPages: ReportPage[] = [];
  const gaps: { page?: string; message: string }[] = [];
  for (const o of out) {
    const p = bySlug.get(o.slug);
    if (prev.kept.has(o.slug)) {
      reportPages.push({ page: o.slug, outcome: 'written', kept: 'edited', ...(p ? {} : { generatorSkipped: skipReason.get(o.slug) ?? 'the generator does not produce this page from the current spec' }) });
      const failure = validation.findings.find((f) => f.severity === 'error' && slugOf(f) === o.slug);
      if (failure) gaps.push({ page: o.slug, message: `This page was edited by a person and is kept as they left it. It no longer passes validation against this spec (${failure.code}: ${failure.message}) and needs their attention.` });
      continue;
    }
    reportPages.push({ page: o.slug, outcome: 'written', ...(p!.placeholders.length ? { placeholderValues: true } : {}), type: p!.type, title: p!.title, operations: p!.operations, sha256: sha256(o.bytes) });
    for (const message of p!.gaps) gaps.push({ page: o.slug, message });
  }
  const written = new Set(out.map((o) => o.slug));
  for (const s of skipped) if (!written.has(s.page) && /^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(s.page)) reportPages.push({ page: s.page, outcome: 'skipped', reason: s.reason.slice(0, 2000) });
  const omitted: { pages?: number; gaps?: number } = {};
  if (reportPages.length > 1000) omitted.pages = reportPages.length - 1000;
  if (gaps.length > 1000) omitted.gaps = gaps.length - 1000;
  const report: RunReport = {
    generator: GENERATOR,
    contractVersion: CONTRACT_VERSION,
    spec: { title: model.title, version: model.version, openapi: model.openapi, sha256: model.sha256, operations: model.operations.length },
    pages: reportPages.slice(0, 1000),
    gaps: gaps.slice(0, 1000).map((g) => ({ ...g, message: g.message.slice(0, 2000) })),
    specProblems: audit.map((f) => ({
      message: `${f.title}: ${f.count} of ${f.of} ${f.unit}.`,
      ...f,
      subjects: f.subjects.slice(0, 200),
      ...(f.subjects.length > 200 ? { subjectsOmitted: f.subjects.length - 200 } : {}),
    })),
    ...(navKept ? {} : { navSha256: sha256(JSON.stringify(bundle.manifest.nav)) }),
    ...(omitted.pages || omitted.gaps ? { omitted } : {}),
  };
  bundle.files.set('report.json', enc.encode(JSON.stringify(report, null, 2) + '\n'));
  // Put the files in a fixed order, so that writing them does not depend on how they were built.
  const files: BundleFiles = new Map([...bundle.files].sort(([a], [b]) => compareCodePoints(a, b)));
  validation = validate(files);
  const auditMarkdown = renderAudit(model, audit, { pages: out.length, skipped: reportPages.filter((p) => p.outcome === 'skipped').length, operationsInGuides: new Set(pages.flatMap((p) => p.operations)).size });
  return { files, manifest: bundle.manifest, report, validation, auditMarkdown };
}

/** A short, human-readable account of a run. */
export function summarize(report: RunReport, v: ValidationReport): string {
  const out: string[] = [];
  out.push(`${report.spec.title} ${report.spec.version} (OpenAPI ${report.spec.openapi}, ${report.spec.operations} operations)`);
  out.push(`spec sha256 ${report.spec.sha256}`, '');
  const written = report.pages.filter((p) => p.outcome === 'written');
  const skipped = report.pages.filter((p) => p.outcome === 'skipped');
  out.push(`Pages produced: ${written.length}`);
  for (const p of written.slice(0, 40)) out.push(`  ${(p.kept ? 'kept' : p.type ?? '').padEnd(10)} ${p.page}${p.placeholderValues ? '  (placeholder values)' : ''}${p.kept ? '  (edited by a person, left as it is)' : ''}`);
  if (written.length > 40) out.push(`  … and ${written.length - 40} more`);
  out.push('', `Skipped: ${skipped.length}`);
  for (const s of skipped.slice(0, 25)) out.push(`  ${s.page}: ${s.reason}`);
  if (skipped.length > 25) out.push(`  … and ${skipped.length - 25} more (see report.json)`);
  out.push('', `Gaps for a human to complete: ${report.gaps.length}`);
  for (const g of report.gaps.slice(0, 25)) out.push(`  ${g.page ?? ''}: ${g.message}`);
  if (report.gaps.length > 25) out.push(`  … and ${report.gaps.length - 25} more (see report.json)`);
  out.push('', `Spec audit: ${report.specProblems.length} findings for the owner of the spec`);
  for (const f of report.specProblems) out.push(`  ${f.severity.padEnd(6)} ${f.message}`);
  const count = (s: string) => v.findings.filter((f) => f.severity === s).length;
  out.push('', `Contract validation: ${v.ok ? 'passed' : 'FAILED'} (${count('error')} errors, ${count('blocker')} blockers, ${count('warning')} warnings)`);
  if (v.withheld.length) out.push(`  withheld from publishing: ${v.withheld.join(', ')}`);
  for (const e of v.findings.filter((f) => f.severity === 'error').slice(0, 20)) out.push(`  ${e.file}${e.line ? ':' + e.line : ''} ${e.code}: ${e.message}`);
  return out.join('\n') + '\n';
}

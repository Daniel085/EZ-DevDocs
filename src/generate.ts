// Orchestrates a run: analyze the spec, build pages, assemble the bundle, validate it, report.
// Pure: returns the bundle's files in memory. Writing them is the caller's job.

import { findResources } from './analyze.ts';
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
import { loadSpec, type Json, type SpecIssue } from './spec.ts';
import { CONTRACT_VERSION, validateBundle, type BundleFiles, type Finding, type ValidationReport } from './validate.ts';
import { SchemaChecker } from './values.ts';

export const GENERATOR = { name: 'ez-devdocs', version: '0.1.0' };

export interface GenerateOptions {
  manifestSchema: Json;
  /** ISO 8601 timestamp for the manifest. Omit it for byte-identical output across runs. */
  generatedAt?: string;
}

export interface RunReport {
  generator: typeof GENERATOR;
  contractVersion: string;
  spec: { title: string; version: string; openapi: string; sha256: string; operations: number };
  pages: { page: string; type: string; title: string; operations: string[]; placeholderValues: string[] }[];
  skipped: Skipped[];
  /** Per page: what the spec did not say. A human should complete these. */
  gaps: { page: string; message: string }[];
  /** Problems in the spec itself, grouped by code. */
  specIssues: { code: string; count: number; examples: string[] }[];
  validation: ValidationReport;
}

export interface GenerateResult {
  files: BundleFiles;
  manifest: Json;
  report: RunReport;
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

function assemble(pages: Page[], model: ReturnType<typeof loadSpec>, options: GenerateOptions): { files: BundleFiles; manifest: Json } {
  const enc = new TextEncoder();
  const files: BundleFiles = new Map();
  const entry = (p: Page) => ({ page: p.slug });
  const group = (name: string, list: Page[]) => (list.length ? [{ group: name, items: list.map(entry) }] : []);
  const nav = [
    ...pages.filter((p) => p.type === 'quickstart').map(entry),
    ...group('Concepts', pages.filter((p) => p.type === 'concept')),
    ...group('Guides', pages.filter((p) => p.type === 'how-to')),
    ...group('Tutorials', pages.filter((p) => p.type === 'tutorial')),
  ];
  const manifest: Json = {
    contractVersion: CONTRACT_VERSION,
    generator: GENERATOR,
    spec: { sha256: model.sha256, title: model.title, version: model.version },
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    nav,
  };
  files.set('guides.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
  for (const p of pages) files.set(`pages/${p.slug}.md`, enc.encode(p.body));
  return { files, manifest };
}

export class GenerationError extends Error {}

export function generate(spec: string | Uint8Array, options: GenerateOptions): GenerateResult {
  const model = loadSpec(spec);
  const checker = new SchemaChecker(model);
  const resources = findResources(model);
  const validate = (files: BundleFiles) => validateBundle(files, model, { manifestSchema: options.manifestSchema });
  const slugOf = (f: Finding) => /^pages\/(.+)\.md$/.exec(f.file)?.[1];

  // Pages link to each other, so a page that fails validation must be dropped before the others
  // are written. Build once assuming every page exists, then again knowing which ones do.
  const dropped = new Map<string, string>();
  let pages: Page[] = [];
  let skipped: Skipped[] = [];
  let bundle: ReturnType<typeof assemble> | undefined;
  let validation: ValidationReport | undefined;
  let exists: Set<string> | undefined;
  for (let round = 0; round < 6; round++) {
    const results = build({ model, checker, resources, has: (slug) => (exists ? exists.has(slug) : true) && !dropped.has(slug) });
    pages = results.filter(isPage).filter((p) => !dropped.has(p.slug));
    skipped = results.filter((r): r is Skipped => !isPage(r));
    if (pages.length === 0) break;
    if (!exists) {
      exists = new Set(pages.map((p) => p.slug));
      continue;
    }
    bundle = assemble(pages, model, options);
    validation = validate(bundle.files);
    const before = dropped.size;
    for (const e of validation.errors) {
      const slug = slugOf(e);
      if (slug && !dropped.has(slug)) dropped.set(slug, `${e.code}: ${e.message}`);
    }
    if (dropped.size === before) break;
  }
  if (!bundle || !validation || pages.length === 0) {
    throw new GenerationError('No guide could be generated from this specification: ' + (skipped.map((s) => `${s.page} (${s.reason})`).join('; ') || 'it has no operations'));
  }
  for (const [slug, why] of dropped) skipped.push({ page: slug, reason: `generated page failed contract validation and was withheld (${why})` });

  const issues = new Map<string, SpecIssue[]>();
  for (const i of model.issues) issues.set(i.code, [...(issues.get(i.code) ?? []), i]);
  const noExamples = model.operations.filter((op) => op.requestBody && !op.requestBody.example && Object.keys(op.requestBody.examples).length === 0);
  if (noExamples.length) issues.set('no-request-example', noExamples.map((op) => ({ code: 'no-request-example', message: `${op.id} has a request body with no example.` })));
  const noSummary = model.operations.filter((op) => !op.summary && !op.description);
  if (noSummary.length) issues.set('no-description', noSummary.map((op) => ({ code: 'no-description', message: `${op.id} has no summary or description.` })));

  const report: RunReport = {
    generator: GENERATOR,
    contractVersion: CONTRACT_VERSION,
    spec: { title: model.title, version: model.version, openapi: model.openapi, sha256: model.sha256, operations: model.operations.length },
    pages: pages.map((p) => ({ page: p.slug, type: p.type, title: p.title, operations: p.operations, placeholderValues: [...new Set(p.placeholders)] })),
    skipped,
    gaps: pages.flatMap((p) => p.gaps.map((message) => ({ page: p.slug, message }))),
    specIssues: [...issues].map(([code, list]) => ({ code, count: list.length, examples: list.slice(0, 5).map((i) => i.message) })),
    validation,
  };
  return { files: bundle.files, manifest: bundle.manifest, report };
}

/** A short, human-readable account of a run. */
export function summarize(report: RunReport): string {
  const out: string[] = [];
  out.push(`${report.spec.title} ${report.spec.version} (OpenAPI ${report.spec.openapi}, ${report.spec.operations} operations)`);
  out.push(`spec sha256 ${report.spec.sha256}`, '');
  out.push(`Pages produced: ${report.pages.length}`);
  for (const p of report.pages.slice(0, 40)) out.push(`  ${p.type.padEnd(10)} ${p.page}${p.placeholderValues.length ? '  (placeholder values)' : ''}`);
  if (report.pages.length > 40) out.push(`  … and ${report.pages.length - 40} more`);
  out.push('', `Skipped: ${report.skipped.length}`);
  for (const s of report.skipped.slice(0, 25)) out.push(`  ${s.page}: ${s.reason}`);
  if (report.skipped.length > 25) out.push(`  … and ${report.skipped.length - 25} more (see report.json)`);
  out.push('', `Gaps for a human to complete: ${report.gaps.length}`);
  for (const g of report.gaps.slice(0, 25)) out.push(`  ${g.page}: ${g.message}`);
  if (report.gaps.length > 25) out.push(`  … and ${report.gaps.length - 25} more (see report.json)`);
  if (report.specIssues.length) {
    out.push('', 'Spec issues:');
    for (const i of report.specIssues) out.push(`  ${i.code}: ${i.count}`);
  }
  const v = report.validation;
  out.push('', `Contract validation: ${v.ok ? 'passed' : 'FAILED'} (${v.errors.length} errors, ${v.warnings.length} warnings)`);
  for (const e of v.errors.slice(0, 20)) out.push(`  ${e.file}${e.line ? ':' + e.line : ''} ${e.code}: ${e.message}`);
  return out.join('\n') + '\n';
}

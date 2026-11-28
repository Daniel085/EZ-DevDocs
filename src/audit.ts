// The spec audit: what the owner of the API description should fix so that better guides can be
// written from it. It looks only at what standard OpenAPI says, and reports what is missing or
// ambiguous there. Pure.

import { explicitExample, findResources, idPathInResponse } from './analyze.ts';
import { deref, successResponse, type Json, type Operation, type SpecModel } from './spec.ts';
import type { ExtensionInfo } from './extensions.ts';
import { code, meta, prose } from './text.ts';

export type Severity = 'high' | 'medium' | 'low';

export interface AuditFinding {
  code: string;
  /** high: pages are missing or wrong because of it. medium: pages say less. low: polish. */
  severity: Severity;
  title: string;
  /** What was found, and what it costs the documentation. */
  detail: string;
  fix: string;
  /** How many of `of` are affected. */
  count: number;
  of: number;
  /** What `count` and `of` count, for example "operations". */
  unit: string;
  /** Every affected operation id or other subject. */
  subjects: string[];
}

const share = (n: number, of: number): Severity => (of > 0 && n / of >= 0.5 ? 'high' : 'medium');

export function auditSpec(model: SpecModel): AuditFinding[] {
  const out: AuditFinding[] = [];
  const ops = model.operations;
  const live = ops.filter((op) => !op.deprecated);
  const ids = (list: Operation[]) => list.map((op) => op.id);
  const add = (f: Omit<AuditFinding, 'count'> & { count?: number }) => {
    const count = f.count ?? f.subjects.length;
    if (count > 0) out.push({ ...f, count });
  };
  const raw = (op: Operation): Json => deref(model.doc, model.doc.paths?.[op.path])?.[op.method] ?? {};

  // Servers and operation ids.
  if (model.servers.length === 0 && ops.length) {
    add({ code: 'no-servers', severity: 'high', title: 'No server URL', unit: 'documents', of: 1, count: 1, subjects: [], detail: 'The description lists no servers, so no page can say where requests go.', fix: 'Add a `servers` entry with the base URL of the API.' });
  }
  const issues = (c: string) => model.issues.filter((i) => i.code === c);
  add({
    code: 'missing-operation-id',
    severity: 'medium',
    title: 'Operations without an operationId',
    unit: 'operations',
    of: ops.length,
    subjects: issues('missing-operation-id').map((i) => i.subject ?? ''),
    detail: 'An identifier was derived from the method and path for each. Links and samples depend on it, so they break if the path changes.',
    fix: 'Give every operation a stable `operationId`.',
  });
  add({
    code: 'duplicate-operation-id',
    severity: 'medium',
    title: 'operationId used more than once',
    unit: 'operations',
    of: ops.length,
    subjects: issues('duplicate-operation-id').map((i) => i.subject ?? ''),
    detail: 'Only one operation can keep a repeated identifier. Each of the others is given one derived from its method and path, which changes if the path does and is not the name its author chose.',
    fix: 'Make each `operationId` unique.',
  });
  add({
    code: 'unresolved-ref',
    severity: 'high',
    title: 'References that do not resolve',
    unit: 'references',
    of: issues('unresolved-ref').length,
    subjects: [...new Set(issues('unresolved-ref').map((i) => i.subject ?? i.message))],
    count: issues('unresolved-ref').length,
    detail: 'A `$ref` points at something that is not in the document, so whatever it stood for was read as empty.',
    fix: 'Correct the reference, or bundle a multi-file description into one document.',
  });

  // What an operation says about itself.
  add({
    code: 'no-description',
    severity: 'medium',
    title: 'Operations with no summary or description',
    unit: 'operations',
    of: ops.length,
    subjects: ids(ops.filter((op) => !op.summary && !op.description)),
    detail: 'A guide step for such an operation can name it but cannot say what it does.',
    fix: 'Add a `summary`, and a `description` where there are rules a caller must know.',
  });
  const params = live.flatMap((op) => op.parameters.map((p) => ({ op, p })));
  const undescribed = params.filter(({ p }) => !p.description);
  add({
    code: 'parameter-no-description',
    severity: 'low',
    title: 'Parameters with no description',
    unit: 'parameters',
    of: params.length,
    count: undescribed.length,
    subjects: [...new Set(undescribed.map(({ op }) => op.id))],
    detail: 'Tables of parameters, such as the one on the pagination page, have empty cells for these.',
    fix: 'Describe each parameter.',
  });

  // Errors.
  const noErrors = live.filter((op) => !op.responses.some((r) => /^([45]\d\d|[45]XX|default)$/i.test(r.status)));
  if (noErrors.length) {
    const ext = new Map<string, number>();
    for (const op of noErrors) for (const k of Object.keys(raw(op))) if (/^x-.*(error|problem|fault|failure)/i.test(k)) ext.set(k, (ext.get(k) ?? 0) + 1);
    const extNote = ext.size
      ? ` ${[...ext].map(([k, n]) => `${n} of them carry the extension field ${code(k)}`).join('; ')}, whose name suggests it describes errors. Extension fields are not part of OpenAPI, and tools that read the standard do not see them.`
      : '';
    add({
      code: 'no-error-responses',
      severity: share(noErrors.length, live.length),
      title: 'Operations that declare no error response',
      unit: 'operations',
      of: live.length,
      subjects: ids(noErrors),
      detail: `These operations list no 4xx, 5xx or \`default\` response, so the description does not say how a call fails.${noErrors.length === live.length ? ' No Errors page could be written, and none on rate limits unless a rate limit header is documented.' : ''}${extNote}`,
      fix: 'Declare each error status under `responses`, with a schema for the error body. A shared response under `components/responses` keeps this short.',
    });
  }

  // Success responses.
  add({
    code: 'no-success-response',
    severity: 'high',
    title: 'Operations with no success response',
    unit: 'operations',
    of: live.length,
    subjects: ids(live.filter((op) => !successResponse(op) && !op.responses.some((r) => /^3(\d\d|XX)$/i.test(r.status)))),
    detail: 'Neither a 2xx nor a 3xx response is declared, so a guide cannot say what a successful call returns.',
    fix: 'Declare the response a successful call returns, and its body.',
  });
  add({
    code: 'success-body-not-described',
    severity: 'medium',
    title: 'Read operations whose response body has no schema',
    unit: 'operations',
    of: live.filter((op) => op.method === 'get').length,
    subjects: ids(live.filter((op) => op.method === 'get' && successResponse(op) && !successResponse(op)!.schema && successResponse(op)!.status !== '204')),
    detail: 'A GET returns something, but its shape is not given. Identifiers cannot be found in it, so flows that start from these operations are skipped.',
    fix: 'Add a schema to the response content.',
  });
  const twoSuccess = live.filter((op) => {
    const ok = op.responses.filter((r) => /^2\d\d$/.test(r.status) && r.schema);
    return ok.length > 1 && new Set(ok.map((r) => JSON.stringify(r.schema))).size === 1;
  });
  add({
    code: 'several-success-statuses',
    severity: 'low',
    title: 'Operations that declare the same body under several success statuses',
    unit: 'operations',
    of: live.length,
    subjects: ids(twoSuccess),
    detail: 'Two or more 2xx statuses carry an identical schema. The description does not say when each is returned, so a guide can only show one of them.',
    fix: 'Keep the status the operation returns, or say in each response description when it applies.',
  });

  // Values a guide needs.
  const pathParams = live.flatMap((op) => op.parameters.filter((p) => p.in === 'path').map((p) => ({ op, p })));
  const noExample = pathParams.filter(({ p }) => explicitExample(model.doc, p) === undefined);
  add({
    code: 'path-parameter-no-example',
    severity: 'medium',
    title: 'Path parameters with no example',
    unit: 'path parameters',
    of: pathParams.length,
    count: noExample.length,
    subjects: [...new Set(noExample.map(({ op }) => op.id))],
    detail: 'An identifier is never made up. Where no earlier call in a guide yields the value and the parameter has no example, the guide is skipped.',
    fix: 'Add an `example` to each path parameter.',
  });
  const withBody = live.filter((op) => op.requestBody);
  const schemaExample = (schema: Json) => {
    const s = deref(model.doc, schema);
    return s?.example !== undefined || (Array.isArray(s?.examples) && s.examples.length > 0);
  };
  add({
    code: 'no-request-example',
    severity: 'medium',
    title: 'Request bodies with no example',
    unit: 'request bodies',
    of: withBody.length,
    subjects: ids(withBody.filter((op) => op.requestBody!.example === undefined && Object.keys(op.requestBody!.examples).length === 0 && !schemaExample(op.requestBody!.schema))),
    detail: 'Sample values for these are built from the schema: defaults, enum values and, failing those, placeholders such as "string". They are valid but not realistic.',
    fix: 'Add an example to the request body or to its schema.',
  });
  const creators = findResources(model).filter((r) => r.create && r.idParam && successResponse(r.create)?.schema && !idPathInResponse(model, r.create, r.idParam));
  add({
    code: 'created-identifier-not-shown',
    severity: 'medium',
    title: 'Create operations whose response does not show the new identifier',
    unit: 'create operations',
    of: findResources(model).filter((r) => r.create && r.idParam).length,
    subjects: creators.map((r) => r.create!.id),
    detail: 'The response schema has no field named like the path parameter of the resource, or `id`, at its top level or one level down. A guide cannot carry the new record into the next call.',
    fix: 'Return the identifier in the response body, under the name the path parameter uses or `id`.',
  });

  // Security.
  const schemes = Object.keys(model.securitySchemes);
  const used = new Set(ops.flatMap((op) => op.security.flatMap((r) => Object.keys(r ?? {}))));
  add({
    code: 'security-scheme-undefined',
    severity: 'high',
    title: 'Security schemes that are required but not defined',
    unit: 'schemes',
    of: used.size,
    subjects: [...used].filter((k) => !schemes.includes(k)),
    detail: 'Operations require a scheme that `components/securitySchemes` does not define, so no page can say how to authenticate.',
    fix: 'Define the scheme, or correct its name in `security`.',
  });
  if (schemes.length && ops.length && !ops.some((op) => op.security.some((r) => Object.keys(r ?? {}).length > 0))) {
    add({ code: 'security-not-applied', severity: 'medium', title: 'Security schemes that no operation requires', unit: 'schemes', of: schemes.length, subjects: schemes, detail: 'Schemes are defined, but no `security` requirement uses them, so every operation reads as public.', fix: 'Add a `security` requirement at the top level or on each operation.' });
  }
  add({
    code: 'security-scheme-no-description',
    severity: 'low',
    title: 'Security schemes with no description',
    unit: 'schemes',
    of: schemes.length,
    subjects: schemes.filter((k) => !model.securitySchemes[k]?.description),
    detail: 'OpenAPI has no field for how a developer obtains credentials. The scheme description is the only place to say it, and it is empty.',
    fix: 'Describe the scheme, including where credentials are issued.',
  });

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count || a.code.localeCompare(b.code));
}

/** The audit as a Markdown document for the owner of the API description. */
export function renderAudit(model: SpecModel, findings: AuditFinding[], extensions: ExtensionInfo[], context: { pages: number; skipped: number; operationsInGuides: number }): string {
  const lines: string[] = [];
  const title = meta(model.title, 120) || 'this API';
  lines.push(`# Spec audit: ${title} ${meta(model.version, 40)}`.trimEnd(), '');
  lines.push(
    `What to change in the API description so that better guides can be generated from it. It covers the description only (OpenAPI ${meta(model.openapi, 20)}, ${model.operations.length} operations, sha256 ${code(model.sha256)}), not the behavior of the API.`,
    '',
    `From this description the generator wrote ${context.pages} pages and skipped ${context.skipped}. ${context.operationsInGuides} of ${model.operations.length} operations appear in a guide. The run report next to this file lists each skipped page with its reason.`,
    '',
  );
  const extensionSection = () => {
    if (extensions.length === 0) return;
    lines.push('## Vendor extensions', '', `The description carries ${extensions.length} extension field${extensions.length > 1 ? 's' : ''} (names that start with ${code('x-')}). They are not part of OpenAPI, so tools that read the standard do not see them. Guides show one only when the settings of a build give it a role.`, '');
    lines.push('| Extension | Used | On | Role in this build | Example value |', '| --- | --- | --- | --- | --- |');
    for (const e of extensions) lines.push(`| ${code(e.name)} | ${e.count} | ${e.where.join(', ')} | ${e.role ?? (e.suggestedRole ? `none (its name suggests ${e.suggestedRole})` : 'none')}${e.shown === false ? ', but it is not on operations, so no page shows it' : ''} | ${prose(e.sample, 80)} |`);
    lines.push('', 'What an extension says that readers need (errors, permissions, what must be switched on) is best said in standard fields too: `responses`, `security` and each operation\'s `description`.', '');
  };
  if (findings.length === 0) {
    lines.push('No findings.', '');
    extensionSection();
    return lines.join('\n');
  }
  const n = (s: Severity) => findings.filter((f) => f.severity === s).length;
  lines.push(`${findings.length} findings: ${n('high')} high, ${n('medium')} medium, ${n('low')} low.`, '');
  lines.push('| Severity | Finding | Affected |', '| --- | --- | --- |');
  for (const f of findings) lines.push(`| ${f.severity} | ${f.title} | ${f.count} of ${f.of} ${f.unit} |`);
  lines.push('', '**High** means pages are missing or wrong because of it. **Medium** means pages say less than they could. **Low** is polish.', '');
  for (const f of findings) {
    lines.push(`## ${f.title}`, '', `Severity: ${f.severity}. Affects ${f.count} of ${f.of} ${f.unit}. Code: ${code(f.code)}.`, '', f.detail, '', `**Fix:** ${f.fix}`, '');
    if (f.subjects.length) {
      const shown = f.subjects.slice(0, 20).map((s) => code(s));
      lines.push(`${f.subjects.length === f.count ? 'Affected' : 'In'}: ${shown.join(', ')}${f.subjects.length > 20 ? `, and ${f.subjects.length - 20} more (all are in the run report)` : ''}.`, '');
    }
  }
  extensionSection();
  return lines.join('\n');
}

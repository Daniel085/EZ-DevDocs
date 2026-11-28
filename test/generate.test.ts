import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { errorsOf, generate, loadSpec, deriveOperationId, SpecError, validateBundle } from '../src/index.ts';
import { sha256 } from '../src/spec.ts';
import { attr, code, meta, prose } from '../src/text.ts';

const root = join(import.meta.dirname, '..');
const manifestSchema = JSON.parse(readFileSync(join(root, 'contract/guides-manifest.schema.json'), 'utf8'));
const reportSchema = JSON.parse(readFileSync(join(root, 'contract/guides-report.schema.json'), 'utf8'));
const skippedOf = (r: { report: { pages: { page: string; outcome: string; reason?: string }[] } }) => r.report.pages.filter((p) => p.outcome === 'skipped');
const dirs = [join(root, 'fixtures/specs'), process.env.EZ_DEVDOCS_EXTRA_SPECS].filter((d): d is string => !!d && existsSync(d));
const specs = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(ya?ml|json)$/.test(f)).sort().map((f) => join(d, f)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

for (const path of specs) {
  const name = path.split('/').at(-1)!;
  test(`${name}: produces a valid, deterministic bundle`, () => {
    const source = readFileSync(path);
    const a = generate(source, { manifestSchema, reportSchema });
    const b = generate(source, { manifestSchema, reportSchema });

    assert.deepEqual(errorsOf(a.validation), []);
    assert.deepEqual(a.validation.findings.filter((f) => f.code === 'invalid-report'), [], 'the report fits its schema');
    assert.deepEqual(a.validation.withheld, [], 'a generated page is never withheld');
    assert.equal(a.validation.ok, true);
    assert.equal(a.manifest.contractVersion, '0.2');
    assert.equal(a.manifest.generatedAt, undefined, 'no clock in the output');
    assert.equal(a.manifest.spec.sha256, sha256(source), 'manifest records the hash of the exact spec bytes');
    assert.deepEqual([...a.files.keys()], [...b.files.keys()], 'same slugs on every run');
    for (const [file, bytes] of a.files) assert.equal(text(bytes), text(b.files.get(file)!), `${file} is identical on every run`);

    // An independent pass over the written files, as the portal would do.
    const again = validateBundle(a.files, loadSpec(source), { manifestSchema, reportSchema });
    assert.deepEqual(errorsOf(again), []);

    const written = a.report.pages.filter((p) => p.outcome === 'written');
    assert.ok(written.length > 0);
    assert.equal(written.length, [...a.files.keys()].filter((f) => f.startsWith('pages/')).length);
    for (const s of skippedOf(a)) assert.ok(s.page && s.reason, 'every skip has a reason');
    assert.ok(a.files.get('report.json')!.byteLength < 2 * 1024 * 1024, 'the report is inside its size limit');

    // Given its own output as the existing bundle, it writes the same bytes again.
    const c = generate(source, { manifestSchema, reportSchema, existing: a.files });
    assert.deepEqual([...c.files.keys()], [...a.files.keys()]);
    for (const [file, bytes] of a.files) assert.equal(text(c.files.get(file)!), text(bytes), `${file} is unchanged when regenerated over itself`);
    for (const [file, bytes] of a.files) {
      if (!file.endsWith('.md')) continue;
      const body = text(bytes);
      assert.doesNotMatch(body, /\bcurl\b|https?:\/\/[^\s)]*\/v\d+\//, `${file} holds no hand-written request`);
      assert.doesNotMatch(body, /\]\((\/|\.\.?\/)/, `${file} has no path links`);
    }
  });
}

test('at least three public specs are covered', () => {
  assert.ok(specs.filter((s) => !s.includes('synthetic')).length >= 3);
});

test('derived operation ids follow the portal rule', () => {
  assert.equal(deriveOperationId('get', '/payments/{id}'), 'get_payments__id_');
  assert.equal(deriveOperationId('POST', '/v1/payment-intents'), 'post_v1_payment_intents');
  const model = loadSpec(readFileSync(join(root, 'fixtures/specs/clubhouse.json')));
  assert.ok(model.operations.every((op) => op.derivedId && /^[a-z]+_[A-Za-z0-9_]*$/.test(op.id)));
  assert.equal(model.issues.filter((i) => i.code === 'missing-operation-id').length, model.operations.length);
});

test('Swagger 2.0 and non-specs are refused with a clear error', () => {
  assert.throws(() => loadSpec('{"swagger":"2.0","paths":{}}'), SpecError);
  assert.throws(() => loadSpec('just: text'), SpecError);
  assert.throws(() => loadSpec('{ not json'), SpecError);
});

test('petstore: quickstart, flows and report', () => {
  const r = generate(readFileSync(join(root, 'fixtures/specs/petstore.yaml')), { manifestSchema });
  const page = (slug: string) => text(r.files.get(`pages/${slug}.md`)!);
  assert.equal(r.manifest.nav[0].page, 'quickstart');
  assert.match(page('quickstart'), /<Step title="Get your credentials">[\s\S]*<Step title="Make your first call">[\s\S]*<Sample operation="[A-Za-z]+"[\s\S]*<Response /);
  assert.match(page('pet/manage'), /<Sample operation="addPet" capture="pet_id=\$\.id">/);
  assert.match(page('pet/manage'), /"petId": "\{\{pet_id\}\}"/);
  assert.ok(skippedOf(r).some((s) => s.page === 'pagination'));
  assert.ok(r.report.gaps.some((g) => g.page === 'quickstart' && /credentials/.test(g.message)));
});

test('museum: named examples and webhooks are used', () => {
  const r = generate(readFileSync(join(root, 'fixtures/specs/museum.yaml')), { manifestSchema });
  const all = [...r.files].filter(([f]) => f.endsWith('.md')).map(([, b]) => text(b)).join('\n');
  assert.match(all, /<Sample operation="[A-Za-z]+" example="[A-Za-z0-9_.-]+"/);
  assert.match(text(r.files.get('pages/webhooks.md')!), /\(schema:SpecialEvent\)/);
});

test('synthetic: hostile descriptions are neutralized, values are carried between calls', () => {
  const r = generate(readFileSync(join(root, 'fixtures/specs/synthetic-orders.yaml')), { manifestSchema });
  const page = (slug: string) => text(r.files.get(`pages/${slug}.md`)!);
  assert.equal(r.validation.ok, true);
  const quickstart = page('quickstart');
  assert.doesNotMatch(quickstart, /<script|<b>|alert\(1\)|\]\(\/docs/);
  assert.doesNotMatch(quickstart, /(^|[^\\])\{\{legacy/);
  assert.match(page('pagination'), /capture="next_cursor=\$\.next_cursor"[\s\S]*"cursor": "\{\{next_cursor\}\}"/);
  assert.match(page('idempotency'), /"Idempotency-Key": "\{\{idempotency_key\}\}"/);
  assert.match(page('tutorials/stores-orders'), /capture="store_id=\$\.id"[\s\S]*"storeId": "\{\{store_id\}\}"[\s\S]*"orderId": "\{\{order_id\}\}"/);
  assert.match(page('tutorials/stores-orders'), /"sku": "ABC-1234"/, 'spec examples win over placeholders');
  assert.ok(!r.files.has('pages/reports/browse.md'), 'deprecated operations get no guide');
  assert.equal(r.report.pages.find((p) => p.page === 'stores/manage')!.placeholderValues, true);
});

test('spec text cannot become active syntax', () => {
  assert.equal(code('a|<img src=x>'), 'a\\|');
  assert.equal(code('^(a|b)$'), '^(a\\|b)$');
  assert.doesNotMatch(code('a\rb'), /\r/);
  assert.equal(code('limit'), '`limit`');
  assert.equal(prose('- item'), '\\- item');
  assert.equal(prose('1. item'), '1\\. item');
  assert.equal(prose('~~~'), '\\~\\~\\~');
  assert.equal(prose('&#123;&#123;api_key&#125;&#125;'), '\\&\\#123;\\&\\#123;api\\_key\\&\\#125;\\&\\#125;');
  assert.equal(prose('see {{api_key}} and <b>x</b>'), 'see \\{\\{api\\_key\\}\\} and x');
  assert.equal(attr('&quot; onclick=&quot;x "y" {z}'), "quot; onclick=quot;x 'y' :z");
  assert.equal(meta('A <b>[x](y)</b> ~~c~~ {d}'), 'A x c d');
});

test('identifiers in a request body come from records created earlier on the page', () => {
  const { files, report } = generate(readFileSync(join(root, 'fixtures/specs/body-references.yaml')), { manifestSchema });
  const page = (slug: string) => text(files.get(`pages/${slug}.md`)!);

  const sites = page('sites/manage');
  assert.match(sites, /<Sample operation="createCustomer" capture="customer_id=\$\.id">/);
  assert.match(sites, /"customer_id": "\{\{customer_id\}\}"/);
  assert.ok(sites.indexOf('operation="createCustomer"') < sites.indexOf('operation="createSite"'), 'the customer is created before the site');
  assert.doesNotMatch(sites, /0199a3c4/, 'no example identifier is left for a record the page creates');

  // A prerequisite's own prerequisite comes first, and each record is created once.
  const orders = page('orders/manage');
  const at = (op: string) => orders.indexOf(`operation="${op}"`);
  assert.ok(at('createCustomer') < at('createSite') && at('createSite') < at('createOrder'));
  assert.equal(orders.split('operation="createCustomer"').length, 2);
  assert.match(orders, /"site_id": "\{\{site_id\}\}"/);

  // Nothing in the spec creates a warehouse: the example stays and the report says so.
  assert.match(orders, /"warehouse_id": "0199a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7d"/);
  assert.ok(report.gaps.some((g) => g.page === 'orders/manage' && g.message.includes("'warehouse_id'")));
  assert.deepEqual(report.pages.find((p) => p.page === 'orders/manage')!.operations!.slice(0, 3), ['createCustomer', 'createSite', 'createOrder']);
});

test('long descriptions end on a whole sentence', () => {
  const t = 'First rule here. ' + 'Second rule goes on for a while. '.repeat(3) + 'A final sentence that is cut.';
  const out = prose(t, 100);
  assert.ok(out.length <= 100 && out.endsWith('. …'), 'ends on a sentence, and the cut is marked');
  assert.ok(prose('word '.repeat(50), 40).endsWith('…'), 'no sentence to end on: cut at a word');
});

test('the quickstart calls an operation that needs credentials when the API has them', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    security: [{ key: [] }],
    paths: {
      '/': { get: { operationId: 'index', security: [], responses: { '200': { description: 'ok' } } } },
      '/me': { get: { operationId: 'whoAmI', summary: 'Who am I', responses: { '200': { description: 'ok' } } } },
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, examples: [{ name: 'a' }] } } } },
          responses: { '201': { description: 'ok' } },
        },
      },
    },
    components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
  };
  const { files, report } = generate(JSON.stringify(spec), { manifestSchema });
  const quickstart = text(files.get('pages/quickstart.md')!);
  assert.match(quickstart, /operation="whoAmI"/);
  assert.match(quickstart, /Get your credentials/);
  assert.ok(!report.gaps.some((g) => g.message.includes('declares no authentication')));
  assert.ok(!report.specProblems.some((i) => i.code === 'no-request-example'), 'an example on the schema counts');
});

test('an idempotency key in the request body is generated and gets its page', () => {
  const { files, validation } = generate(readFileSync(join(root, 'fixtures/specs/body-references.yaml')), { manifestSchema });
  assert.match(text(files.get('pages/orders/manage.md')!), /"idempotency_key": "\{\{idempotency_key\}\}"/);
  const page = text(files.get('pages/idempotency.md')!);
  assert.match(page, /accepts `idempotency_key` in the request body/);
  assert.match(page, /A repeat with the same key answers with what the first one did/);
  assert.match(page, /<Sample operation="createOrder">/);
  assert.deepEqual(errorsOf(validation), []);
});

test('every run audits the spec for its owner', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Audited', version: '1' },
    security: [{ key: [] }],
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          summary: 'Add a thing',
          'x-errors': '409 conflict',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
            '201': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
          },
        },
      },
      '/things/{thing_id}': {
        get: {
          operationId: 'getThing',
          summary: 'Get a thing',
          parameters: [{ name: 'thing_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } }, '404': { description: 'missing' } },
        },
      },
    },
    components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } }, schemas: { Thing: { type: 'object', properties: { name: { type: 'string' } } } } },
  };
  const { report, auditMarkdown, files } = generate(JSON.stringify(spec), { manifestSchema });
  const by = Object.fromEntries(report.specProblems.map((f) => [f.code, f]));
  assert.deepEqual(Object.keys(by).sort(), [
    'created-identifier-not-shown',
    'no-error-responses',
    'no-request-example',
    'no-servers',
    'parameter-no-description',
    'path-parameter-no-example',
    'security-scheme-no-description',
    'several-success-statuses',
  ]);
  assert.deepEqual([by['no-error-responses'].count, by['no-error-responses'].of, by['no-error-responses'].subjects], [1, 2, ['createThing']]);
  assert.match(by['no-error-responses'].detail, /extension field `x-errors`/);
  assert.equal(report.specProblems[0]!.severity, 'high');
  assert.equal(by['no-error-responses'].message, 'Operations that declare no error response: 1 of 2 operations.');
  assert.match(auditMarkdown, /^# Spec audit: Audited 1\n/);
  assert.match(auditMarkdown, /\*\*Fix:\*\* Add an `example` to each path parameter\./);
  assert.ok(![...files.keys()].some((f) => /audit/.test(f)), 'the audit document is not part of the bundle');
  assert.ok(files.has('report.json'), 'the report is');
  assert.equal(generate(JSON.stringify(spec), { manifestSchema }).auditMarkdown, auditMarkdown, 'same audit on every run');
});

test('spec text in the audit is inert', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Evil <script>alert(1)</script> {{api_key}}', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: { '/a': { get: { operationId: 'a`b|c', responses: { '200': { description: 'ok' } } } } },
  };
  const { auditMarkdown } = generate(JSON.stringify(spec), { manifestSchema });
  assert.doesNotMatch(auditMarkdown, /<script>|[^\\]\{\{api_key/);
  assert.doesNotMatch(auditMarkdown, /`a`b/);
});

// --- Regenerating over a bundle that people have edited (contract 4.7)

import { parse as parseYaml } from 'yaml';

const refs = () => parseYaml(readFileSync(join(root, 'fixtures/specs/body-references.yaml'), 'utf8'));
const gen = (spec: unknown, existing?: Map<string, Uint8Array>) => generate(JSON.stringify(spec), { manifestSchema, reportSchema, existing });
const enc8 = new TextEncoder();

test('a page a person edited is kept byte for byte, and the others are regenerated', () => {
  const first = gen(refs());
  const edited = new Map(first.files);
  const mine = text(first.files.get('pages/sites/manage.md')!).replace('This guide creates a site', 'Our own words: this guide creates a site');
  edited.set('pages/sites/manage.md', enc8.encode(mine));

  // The spec changes too: orders gain a summary, which the orders page shows.
  const spec = refs();
  spec.paths['/orders'].post.summary = 'Place an order';
  const second = gen(spec, edited);
  assert.equal(text(second.files.get('pages/sites/manage.md')!), mine, 'the edit survives');
  assert.match(text(second.files.get('pages/orders/manage.md')!), /Place an order/, 'an untouched page is regenerated');
  assert.equal(text(second.files.get('pages/customers/manage.md')!), text(first.files.get('pages/customers/manage.md')!), 'a page the change does not reach is byte for byte as before');
  const entry = second.report.pages.find((p) => p.page === 'sites/manage')!;
  assert.deepEqual([entry.outcome, entry.kept, entry.sha256], ['written', 'edited', undefined]);
  assert.deepEqual(second.manifest.nav, first.manifest.nav, 'same place in nav');

  // And it stays kept on the run after that.
  const third = gen(spec, second.files);
  assert.equal(text(third.files.get('pages/sites/manage.md')!), mine);
  assert.equal(third.report.pages.find((p) => p.page === 'sites/manage')!.kept, 'edited');
});

test('an edited page that no longer fits the spec is kept, and the report says so', () => {
  const first = gen(refs());
  const edited = new Map(first.files);
  edited.set('pages/sites/manage.md', enc8.encode(text(first.files.get('pages/sites/manage.md')!) + '\nA note from a person.\n'));
  const spec = refs();
  delete spec.paths['/sites'];
  delete spec.paths['/sites/{site_id}'];
  const second = gen(spec, edited);
  assert.match(text(second.files.get('pages/sites/manage.md')!), /A note from a person\./);
  assert.equal(second.validation.ok, false, 'the page names operations that are gone, and that is not hidden');
  assert.ok(second.report.gaps.some((g) => g.page === 'sites/manage' && /edited by a person/.test(g.message) && /unknown-operation/.test(g.message)));
  assert.equal(second.report.pages.find((p) => p.page === 'sites/manage')!.kept, 'edited');
});

test('a page nobody edited goes when the spec no longer supports it', () => {
  const first = gen(refs());
  const spec = refs();
  delete spec.paths['/sites'];
  delete spec.paths['/sites/{site_id}'];
  const second = gen(spec, first.files);
  assert.ok(first.files.has('pages/sites/manage.md') && !second.files.has('pages/sites/manage.md'));
  assert.equal(second.validation.ok, true);
});

test("a person's page and a person's navigation are kept", () => {
  const first = gen(refs());
  const edited = new Map(first.files);
  edited.set('pages/faq.md', enc8.encode('---\ntitle: Questions\ndescription: Things people ask.\ntype: concept\n---\n\nAsk away.\n'));
  const manifest = JSON.parse(text(first.files.get('guides.json')!));
  manifest.nav = [{ page: 'faq', label: 'FAQ' }, ...manifest.nav.slice().reverse()];
  edited.set('guides.json', enc8.encode(JSON.stringify(manifest, null, 2) + '\n'));
  edited.set('assets/logo.png', enc8.encode('png'));

  const spec = refs();
  spec.paths['/warehouses'] = { post: { operationId: 'createWarehouse', summary: 'Add a warehouse', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'North' } } } } } }, responses: { '201': spec.paths['/warehouses/{warehouse_id}'].get.responses['200'] } } };
  const second = gen(spec, edited);
  assert.equal(second.validation.ok, true);
  assert.ok(second.files.has('pages/faq.md') && second.files.has('assets/logo.png'));
  assert.deepEqual(second.manifest.nav[0], { page: 'faq', label: 'FAQ' });
  assert.deepEqual(second.manifest.nav.slice(1, -1).map((x: { group?: string; page?: string }) => x.group ?? x.page), manifest.nav.slice(1, -1).map((x: { group?: string; page?: string }) => x.group ?? x.page), "the person's order stands");
  const guides = second.manifest.nav.find((x: { group?: string }) => x.group === 'Guides').items.map((x: { page: string }) => x.page);
  assert.equal(guides.at(-1), 'warehouses/manage', 'a new page is added to its group');
  assert.equal(second.report.navSha256, undefined, 'the navigation is recorded as not this module\'s');
});

test('without a record of what was generated, every existing page is kept', () => {
  const first = gen(refs());
  const noReport = new Map(first.files);
  noReport.delete('report.json');
  const spec = refs();
  spec.paths['/orders'].post.summary = 'Place an order';
  const second = gen(spec, noReport);
  assert.equal(text(second.files.get('pages/orders/manage.md')!), text(first.files.get('pages/orders/manage.md')!));
  assert.ok(second.report.pages.filter((p) => p.outcome === 'written').every((p) => p.kept === 'edited'));
});

test('a guide only changes or deletes a record it created', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: {
      '/keys': { get: { operationId: 'listKeys', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } } } } } },
      '/keys/{key_id}': {
        parameters: [{ name: 'key_id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'getKey', responses: { '200': { description: 'ok' } } },
        patch: { operationId: 'updateKey', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'a' } } } } } }, responses: { '200': { description: 'ok' } } },
        delete: { operationId: 'deleteKey', responses: { '204': { description: 'gone' } } },
      },
    },
  };
  const { files, report } = generate(JSON.stringify(spec), { manifestSchema });
  const page = text(files.get('pages/keys/browse.md')!);
  assert.match(page, /operation="listKeys"[\s\S]*operation="getKey"/);
  assert.doesNotMatch(page, /deleteKey|updateKey/);
  assert.deepEqual(report.pages.find((p) => p.page === 'keys/browse')!.operations, ['listKeys', 'getKey']);
});

test('two example identifiers in one body are two records; a list of identifiers is bound too', () => {
  const thing = { type: 'object', properties: { id: { type: 'string' } } };
  const created = (schema: unknown) => ({ '201': { description: 'ok', content: { 'application/json': { schema } } } });
  const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    tags: [{ name: 'Selling' }, { name: 'Catalog' }],
    paths: {
      '/items': { post: { operationId: 'createItem', summary: 'Add an item', tags: ['Catalog'], requestBody: body({ type: 'object', properties: { sku: { type: 'string', example: 'A-1' } } }), responses: created(thing) } },
      '/items/{item_id}': { get: { operationId: 'getItem', tags: ['Catalog'], parameters: [{ name: 'item_id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: thing } } } } } },
      '/labels': { post: { operationId: 'createLabel', tags: ['Catalog'], requestBody: body({ type: 'object', properties: { name: { type: 'string', example: 'new' } } }), responses: created(thing) } },
      '/labels/{label_id}': { get: { operationId: 'getLabel', tags: ['Catalog'], parameters: [{ name: 'label_id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: thing } } } } } },
      '/orders': {
        post: {
          operationId: 'createOrder',
          summary: 'Write up an order',
          tags: ['Selling'],
          requestBody: body({
            type: 'object',
            properties: { label_ids: { type: 'array', items: { type: 'string' } }, lines: { type: 'array', items: { type: 'object', properties: { item_id: { type: 'string' } } } } },
            examples: [{ label_ids: ['l-1'], lines: [{ item_id: 'i-1' }, { item_id: 'i-2' }, { item_id: 'i-1' }] }],
          }),
          responses: created(thing),
        },
      },
      '/orders/{order_id}': { get: { operationId: 'getOrder', summary: 'Get an order', tags: ['Selling'], parameters: [{ name: 'order_id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: thing } } } } } },
    },
  };
  const { files, manifest, validation } = generate(JSON.stringify(spec), { manifestSchema, reportSchema });
  assert.deepEqual(errorsOf(validation), []);
  const page = text(files.get('pages/orders/manage.md')!);
  assert.match(page, /capture="item_id=\$\.id"[\s\S]*capture="item_id_2=\$\.id"/, 'each different example item is created');
  assert.match(page, /"item_id": "\{\{item_id\}\}"[\s\S]*"item_id": "\{\{item_id_2\}\}"[\s\S]*"item_id": "\{\{item_id\}\}"/, 'the same example is the same record');
  assert.match(page, /"label_ids": \[\s*"\{\{label_id\}\}"\s*\]/);
  assert.doesNotMatch(page, /"(i-1|i-2|l-1)"/);

  // Prerequisites sit in their own block, and steps are named as the spec names them.
  const before = page.indexOf('## Before you start');
  const task = page.indexOf('## Create the order, then retrieve it');
  assert.ok(before > 0 && task > before && page.indexOf('operation="createItem"') < task && page.indexOf('operation="createOrder"') > task);
  assert.match(page, /<Step title="Add an item">[\s\S]*<Step title="Write up an order">[\s\S]*<Step title="Get an order">/);

  // Navigation follows the spec's tags, in the spec's order.
  assert.deepEqual(manifest.nav.filter((n: { group?: string }) => n.group).map((n: { group: string; items: { page: string }[] }) => [n.group, n.items.map((i) => i.page)]), [
    ['Selling', ['orders/manage']],
    ['Catalog', ['items/manage', 'labels/manage']],
  ]);
});

test('titles keep the path segments that tell resources apart', () => {
  const list = { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } } } };
  const one = (id: string) => ({ get: { operationId: id, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } });
  const spec = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: {
      '/v1/treasury/transactions': { get: { operationId: 'listTreasury', responses: list } },
      '/v1/treasury/transactions/{id}': one('getTreasury'),
      '/v1/issuing/transactions': { get: { operationId: 'listIssuing', responses: list } },
      '/v1/issuing/transactions/{id}': one('getIssuing'),
    },
  };
  const { report } = generate(JSON.stringify(spec), { manifestSchema });
  assert.deepEqual(report.pages.filter((p) => p.type === 'how-to').map((p) => p.title).sort(), ['List and retrieve issuing transactions', 'List and retrieve treasury transactions']);
});

test('an action on a record gets a guide of its own, titled as the spec titles it', () => {
  const thing = { type: 'object', properties: { id: { type: 'string' } } };
  const ok = { '200': { description: 'ok', content: { 'application/json': { schema: thing } } } };
  const id = [{ name: 'order_id', in: 'path', required: true, schema: { type: 'string' }, example: 'made-up' }];
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: {
      '/orders': { post: { operationId: 'createOrder', summary: 'Write up an order', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string', example: 'x' } } } } } }, responses: { '201': ok['200'] } } },
      '/orders/{order_id}': { get: { operationId: 'getOrder', parameters: id, responses: ok } },
      '/orders/{order_id}/payments': { post: { operationId: 'takePayment', summary: 'Take a payment', parameters: id, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { amount: { type: 'string', example: '10.00' } } } } } }, responses: ok } },
      '/orders/{order_id}/cancel': { post: { operationId: 'cancelOrder', parameters: id, responses: ok } },
      '/orders/{order_id}/lines': { get: { operationId: 'listLines', parameters: id, responses: ok }, post: { operationId: 'addLine', parameters: id, responses: ok } },
    },
  };
  const { files, report, validation } = generate(JSON.stringify(spec), { manifestSchema, reportSchema });
  assert.deepEqual(errorsOf(validation), []);
  const page = text(files.get('pages/orders/payments.md')!);
  assert.match(page, /^title: "Take a payment"$/m);
  assert.match(page, /operation="createOrder" capture="order_id=\$\.id"[\s\S]*<Step title="Take a payment">[\s\S]*"order_id": "\{\{order_id\}\}"[\s\S]*"amount": "10\.00"/);
  assert.doesNotMatch(page, /made-up/, 'the record acted on is the one the guide created, not the example');
  assert.equal(report.pages.find((p) => p.page === 'orders/cancel')!.title, 'Cancel an order');
  assert.ok(!files.has('pages/orders/lines.md'), 'a collection under the record is not an action');
  assert.ok(![...files.keys()].some((f) => text(files.get(f)!).includes('made-up')), 'no page is written from a made-up parent identifier');
});

test('the record a path parameter names is found by its id only when the parameter is one', () => {
  const made = (props: object) => ({ '201': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: props } } } } });
  const body = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'a' } } } } } };
  const get = (name: string) => ({ get: { operationId: `get_${name}`, parameters: [{ name, in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } });
  const spec = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: {
      '/customers': { post: { operationId: 'createCustomer', requestBody: body, responses: made({ id: { type: 'string' } }) } },
      '/customers/{customer}': get('customer'),
      '/payment_intents': { post: { operationId: 'createIntent', requestBody: body, responses: made({ id: { type: 'string' } }) } },
      '/payment_intents/{intent}': get('intent'),
      '/users': { post: { operationId: 'createUser', requestBody: body, responses: made({ id: { type: 'integer' }, login: { type: 'string' } }) } },
      '/users/{username}': get('username'),
    },
  };
  const { files, report } = generate(JSON.stringify(spec), { manifestSchema });
  assert.match(text(files.get('pages/customers/manage.md')!), /capture="customer_id=\$\.id"/);
  assert.match(text(files.get('pages/payment-intents/manage.md')!), /capture="intent_id=\$\.id"/);
  assert.ok(!files.has('pages/users/manage.md'), 'a numeric id is not sent as a username');
  assert.match(report.pages.find((p) => p.page === 'users/manage')!.reason!, /does not show where the new identifier is/);
});

test('a page built from placeholder values says so', () => {
  const r = generate(readFileSync(join(root, 'fixtures/specs/synthetic-orders.yaml')), { manifestSchema });
  const flagged = r.report.pages.filter((p) => p.placeholderValues).map((p) => p.page);
  assert.ok(flagged.length > 0);
  for (const [file, bytes] of r.files) {
    if (!file.startsWith('pages/')) continue;
    assert.equal(text(bytes).includes('<Callout type="warning" title="Placeholder values">'), flagged.includes(file.slice(6, -3)), file);
  }
});

test('a create step reports 201 where the spec declares it', () => {
  const page = text(generate(readFileSync(join(root, 'fixtures/specs/body-references.yaml')), { manifestSchema }).files.get('pages/customers/manage.md')!);
  assert.match(page, /A successful call returns `201`/);
});

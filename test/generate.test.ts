import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generate, loadSpec, deriveOperationId, SpecError, validateBundle } from '../src/index.ts';
import { sha256 } from '../src/spec.ts';
import { attr, code, meta, prose } from '../src/text.ts';

const root = join(import.meta.dirname, '..');
const manifestSchema = JSON.parse(readFileSync(join(root, 'contract/guides-manifest.schema.json'), 'utf8'));
const dirs = [join(root, 'fixtures/specs'), process.env.EZ_DEVDOCS_EXTRA_SPECS].filter((d): d is string => !!d && existsSync(d));
const specs = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(ya?ml|json)$/.test(f)).sort().map((f) => join(d, f)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

for (const path of specs) {
  const name = path.split('/').at(-1)!;
  test(`${name}: produces a valid, deterministic bundle`, () => {
    const source = readFileSync(path);
    const a = generate(source, { manifestSchema });
    const b = generate(source, { manifestSchema });

    assert.deepEqual(a.report.validation.errors, []);
    assert.equal(a.report.validation.ok, true);
    assert.equal(a.manifest.spec.sha256, sha256(source), 'manifest records the hash of the exact spec bytes');
    assert.deepEqual([...a.files.keys()], [...b.files.keys()], 'same slugs on every run');
    for (const [file, bytes] of a.files) assert.equal(text(bytes), text(b.files.get(file)!), `${file} is identical on every run`);

    // An independent pass over the written files, as the portal would do.
    const again = validateBundle(a.files, loadSpec(source), { manifestSchema });
    assert.deepEqual(again.errors, []);

    assert.ok(a.report.pages.length > 0);
    assert.equal(a.report.pages.length, [...a.files.keys()].filter((f) => f.startsWith('pages/')).length);
    for (const s of a.report.skipped) assert.ok(s.page && s.reason, 'every skip has a reason');
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
  assert.ok(r.report.skipped.some((s) => s.page === 'pagination'));
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
  assert.equal(r.report.validation.ok, true);
  const quickstart = page('quickstart');
  assert.doesNotMatch(quickstart, /<script|<b>|alert\(1\)|\]\(\/docs/);
  assert.doesNotMatch(quickstart, /(^|[^\\])\{\{legacy/);
  assert.match(page('pagination'), /capture="next_cursor=\$\.next_cursor"[\s\S]*"cursor": "\{\{next_cursor\}\}"/);
  assert.match(page('idempotency'), /"Idempotency-Key": "\{\{idempotency_key\}\}"/);
  assert.match(page('tutorials/stores-orders'), /capture="store_id=\$\.id"[\s\S]*"storeId": "\{\{store_id\}\}"[\s\S]*"orderId": "\{\{order_id\}\}"/);
  assert.match(page('tutorials/stores-orders'), /"sku": "ABC-1234"/, 'spec examples win over placeholders');
  assert.ok(!r.files.has('pages/reports/browse.md'), 'deprecated operations get no guide');
  assert.ok(r.report.pages.find((p) => p.page === 'stores/manage')!.placeholderValues.length > 0);
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
  assert.deepEqual(report.pages.find((p) => p.page === 'orders/manage')!.operations.slice(0, 3), ['createCustomer', 'createSite', 'createOrder']);
});

test('long descriptions end on a whole sentence', () => {
  const t = 'First rule here. ' + 'Second rule goes on for a while. '.repeat(3) + 'A final sentence that is cut.';
  const out = prose(t, 100);
  assert.ok(out.length <= 100 && out.endsWith('.') && !out.includes('…'));
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
  assert.ok(!report.specIssues.some((i) => i.code === 'no-request-example'), 'an example on the schema counts');
});

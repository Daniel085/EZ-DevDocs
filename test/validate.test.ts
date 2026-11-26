import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSpec, validateBundle } from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const manifestSchema = JSON.parse(readFileSync(join(root, 'contract/guides-manifest.schema.json'), 'utf8'));
const model = loadSpec(readFileSync(join(root, 'fixtures/specs/synthetic-orders.yaml')));
const enc = new TextEncoder();

const FM = '---\ntitle: T\ndescription: D\ntype: how-to\noperations: [get_stores]\n---\n\n';
const manifest = (nav: unknown, extra: object = {}) => JSON.stringify({ contractVersion: '0.1', generator: { name: 'x', version: '1' }, spec: { sha256: model.sha256 }, nav, ...extra });

function check(body: string, opts: { frontmatter?: string; files?: Record<string, string>; nav?: unknown } = {}) {
  const files = new Map<string, Uint8Array>();
  files.set('guides.json', enc.encode(manifest(opts.nav ?? [{ page: 'a' }, ...Object.keys(opts.files ?? {}).filter((f) => f.startsWith('pages/')).map((f) => ({ page: f.slice(6, -3) }))])));
  files.set('pages/a.md', enc.encode((opts.frontmatter ?? FM) + body));
  for (const [f, c] of Object.entries(opts.files ?? {})) files.set(f, enc.encode(c));
  return validateBundle(files, model, { manifestSchema });
}
const codes = (r: ReturnType<typeof check>) => r.errors.map((e) => e.code);

test('accepts everything the contract allows', () => {
  const body = [
    '## Heading',
    'Text with {{api_name}}, a literal \\{{not_a_var}}, `<inline code {x}>` and a [link](https://example.com).',
    'See [op](op:get_stores), [schema](schema:Store), [guide](guide:b#part) and ![chart](asset:flow.png).',
    '<Callout type="warning" title="Careful">',
    'Body.',
    '</Callout>',
    '<Tabs>',
    '<Tab title="macOS">',
    '```bash title="Install the CLI" highlight="1,3-4"',
    'npm install -g acme-cli',
    '```',
    '</Tab>',
    '</Tabs>',
    '<CardGroup cols="2">',
    '<Card title="Next" href="guide:b" />',
    '</CardGroup>',
    '<Operation id="get_stores" />',
    '<Schema ref="Store" />',
    '<Response operation="post_stores" status="201" />',
    '<Sample operation="post_stores" title="Create" capture="store_id=$.id">',
    '```json',
    '{ "path": {}, "query": {}, "headers": { "Idempotency-Key": "{{idempotency_key}}" }, "body": { "name": "Main St", "currency": "eur" } }',
    '```',
    '</Sample>',
    '<Sample operation="get_stores__storeId_">',
    '```json',
    '{ "path": { "storeId": "{{store_id}}" } }',
    '```',
    '</Sample>',
    '- [x] task',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 < 2 | ~~x~~ |',
  ].join('\n');
  const r = check(body, { files: { 'pages/b.md': FM + 'x\n', 'assets/flow.png': 'png' } });
  assert.deepEqual(r.errors, []);
});

const rejects: [string, string, string][] = [
  ['raw HTML', '<div>hi</div>', 'disallowed-syntax'],
  ['script', '<script>alert(1)</script>', 'disallowed-syntax'],
  ['iframe', '<iframe src="https://x.example"></iframe>', 'disallowed-syntax'],
  ['HTML comment', '<!-- hidden -->', 'disallowed-syntax'],
  ['inline event handler', '<Callout type="note" onclick="x()">\nx\n</Callout>', 'unknown-attribute'],
  ['unknown component', '<Video src="https://x.example/v.mp4" />', 'unknown-component'],
  ['unknown attribute', '<Operation id="get_stores" color="red" />', 'unknown-attribute'],
  ['JSX attribute', '<CardGroup cols={2}>\n</CardGroup>', 'disallowed-syntax'],
  ['JSX expression', 'Total: {1 + 1}', 'disallowed-syntax'],
  ['import', 'import X from "./x"', 'disallowed-syntax'],
  ['h1', '# Title', 'heading-h1'],
  ['setext h1', 'Title\n=====', 'heading-h1'],
  ['unknown variable', 'Use {{secret}}.', 'unknown-variable'],
  ['unknown variable in code', '```bash\necho {{nope}}\n```', 'unknown-variable'],
  ['variable used before capture', '<Sample operation="get_stores__storeId_">\n```json\n{ "path": { "storeId": "{{store_id}}" } }\n```\n</Sample>', 'unknown-variable'],
  ['relative link', '[x](../other)', 'link-not-allowed'],
  ['absolute path link', '[x](/reference/op)', 'link-not-allowed'],
  ['http link', '[x](http://example.com)', 'link-not-allowed'],
  ['javascript link', '[x](javascript:alert(1))', 'link-not-allowed'],
  ['unknown operation link', '[x](op:nope)', 'unknown-operation'],
  ['unknown schema', '<Schema ref="Nope" />', 'unknown-schema'],
  ['unknown guide', '[x](guide:nope)', 'unknown-guide'],
  ['unknown asset', '![x](asset:nope.png)', 'unknown-asset'],
  ['unknown operation in sample', '<Sample operation="nope" />', 'unknown-operation'],
  ['unknown response status', '<Response operation="get_stores" status="418" />', 'unknown-response'],
  ['unknown named example', '<Sample operation="post_stores" example="nope" />', 'unknown-example'],
  ['sample missing required values', '<Sample operation="post_stores" />', 'invalid-sample'],
  ['sample body fails schema', '<Sample operation="post_stores">\n```json\n{ "body": { "name": "ab", "currency": "gbp" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with unknown parameter', '<Sample operation="get_stores">\n```json\n{ "query": { "sort": "asc" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with wrong parameter type', '<Sample operation="get_stores">\n```json\n{ "query": { "limit": 500 } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with prose inside', '<Sample operation="get_stores">\nhello\n</Sample>', 'invalid-sample'],
  ['bad capture', '<Sample operation="get_stores" capture="x" />', 'invalid-capture'],
  ['hand-written request', '```bash\ncurl -X POST {{base_url}}/stores\n```', 'api-request-code'],
  ['hand-written fetch', '```js\nawait fetch(`{{base_url}}/stores`)\n```', 'api-request-code'],
  ['unclosed component', '<Steps>\n<Step title="a">\nx\n</Step>', 'unbalanced-component'],
  ['step outside steps', '<Step title="a">\nx\n</Step>', 'invalid-nesting'],
  ['bad code info', '```bash onclick="x"\nls\n```', 'invalid-code-info'],
];
for (const [name, body, code] of rejects) {
  test(`rejects ${name}`, () => assert.ok(codes(check(body + '\n')).includes(code), `expected ${code}, got ${codes(check(body + '\n')).join(', ') || 'no errors'}`));
}

test('frontmatter rules', () => {
  assert.ok(codes(check('x\n', { frontmatter: 'no frontmatter\n' })).includes('invalid-frontmatter'));
  assert.ok(codes(check('x\n', { frontmatter: `---\ntitle: ${'t'.repeat(81)}\ndescription: D\ntype: how-to\n---\n` })).includes('invalid-frontmatter'));
  assert.ok(codes(check('x\n', { frontmatter: '---\ntitle: T\ndescription: D\ntype: blog\n---\n' })).includes('invalid-frontmatter'));
  assert.ok(codes(check('x\n', { frontmatter: '---\ntitle: T\ndescription: D\ntype: how-to\nlayout: wide\n---\n' })).includes('invalid-frontmatter'));
  assert.ok(codes(check('x\n', { frontmatter: '---\ntitle: T\ndescription: D\ntype: how-to\noperations: [nope]\n---\n' })).includes('unknown-operation'));
});

test('manifest and layout rules', () => {
  assert.ok(codes(check('x\n', { nav: [{ page: 'a' }, { page: 'a' }] })).includes('duplicate-page'));
  assert.ok(codes(check('x\n', { nav: [{ page: 'a' }, { page: 'ghost' }] })).includes('missing-page'));
  assert.ok(codes(check('x\n', { nav: [{ page: 'a' }], files: { 'pages/orphan.md': FM + 'x\n' } })).includes('missing-page'));
  assert.ok(codes(check('x\n', { nav: [{ page: 'a', extra: 1 }] })).includes('invalid-manifest'));
  const deep = [{ group: '1', items: [{ group: '2', items: [{ group: '3', items: [{ group: '4', items: [{ page: 'a' }] }] }] }] }];
  assert.ok(codes(check('x\n', { nav: deep })).includes('nav-depth'));
  assert.ok(codes(check('x\n', { files: { 'assets/run.exe': 'x' } })).includes('asset-type'));
  assert.ok(codes(check('x\n', { files: { 'assets/Flow.png': 'x' } })).includes('invalid-path'));
  assert.ok(codes(check('x\r\n')).includes('invalid-encoding'));
});

test('warnings do not block', () => {
  const r = check('![](https://example.com/a.png)\n\n<Operation id="get_reports__reportId_" />\n', { frontmatter: '---\ntitle: T\ndescription: D\ntype: concept\n---\n' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['deprecated-operation', 'image-missing-alt', 'page-unreferenced']);
});

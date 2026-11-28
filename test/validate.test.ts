import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignOperationIds, loadSpec, validateBundle } from '../src/index.ts';
import { headingAnchor, parseCapture } from '../src/validate.ts';

const root = join(import.meta.dirname, '..');
const manifestSchema = JSON.parse(readFileSync(join(root, 'contract/guides-manifest.schema.json'), 'utf8'));
const reportSchema = JSON.parse(readFileSync(join(root, 'contract/guides-report.schema.json'), 'utf8'));
const model = loadSpec(readFileSync(join(root, 'fixtures/specs/synthetic-orders.yaml')));
const enc = new TextEncoder();

const FM = '---\ntitle: T\ndescription: D\ntype: how-to\noperations: [get_stores]\n---\n\n';
const manifest = (nav: unknown, extra: object = {}) => JSON.stringify({ contractVersion: '0.2', generator: { name: 'x', version: '1' }, spec: { sha256: model.sha256 }, nav, ...extra });

function check(body: string, opts: { frontmatter?: string; files?: Record<string, string>; nav?: unknown; manifest?: string } = {}) {
  const files = new Map<string, Uint8Array>();
  files.set('guides.json', enc.encode(opts.manifest ?? manifest(opts.nav ?? [{ page: 'a' }, ...Object.keys(opts.files ?? {}).filter((f) => f.startsWith('pages/')).map((f) => ({ page: f.slice(6, -3) }))])));
  files.set('pages/a.md', enc.encode((opts.frontmatter ?? FM) + body));
  for (const [f, c] of Object.entries(opts.files ?? {})) files.set(f, enc.encode(c));
  return validateBundle(files, model, { manifestSchema, reportSchema });
}
const of = (r: ReturnType<typeof check>, severity: string) => r.findings.filter((f) => f.severity === severity).map((f) => f.code);
const codes = (r: ReturnType<typeof check>) => of(r, 'error');

test('accepts everything the contract allows', () => {
  const body = [
    '## Heading',
    '',
    'Text with {{api_name}}, a literal \\{{not_a_var}}, `<inline code {{x}}>` and a [link](https://example.com/a?b=1).',
    'See [op](op:get_stores), [schema](schema:Store), [guide](guide:b#part-one) and ![chart](asset:flow.png).',
    'A lone { brace }, an import statement and {1 + 1} are ordinary text.',
    '',
    '<Callout title="Careful">',
    '',
    'Body.',
    '',
    '</Callout>',
    '',
    '<Tabs>',
    '<Tab title="macOS">',
    '',
    '```bash title="Install the CLI" highlight="1,3-4"',
    'npm install -g acme-cli',
    '```',
    '',
    '</Tab>',
    '</Tabs>',
    '',
    '<CardGroup cols="2">',
    '<Card title="Next" href="guide:b" />',
    '<Card title="No link" />',
    '</CardGroup>',
    '',
    '<Operation id="get_stores" />',
    '',
    '<Schema ref="Store" />',
    '',
    '<Response operation="post_stores" status="201" />',
    '',
    '<Sample operation="post_stores" />',
    '',
    '<Sample operation="post_stores" title="Create" capture="store_id=$.id other=$.items[0].id" tryIt="false">',
    '```json',
    '{ "headers": { "Idempotency-Key": "{{idempotency_key}}" }, "body": { "name": "Main St", "currency": "eur" } }',
    '```',
    '</Sample>',
    '',
    '<Sample operation="get_stores__storeId_">',
    '',
    '```json',
    '{ "path": { "storeId": "{{store_id}}" } }',
    '```',
    '',
    '</Sample>',
    '',
    'A footnote[^1], an escaped \\<b\\> and \\{brace\\}.',
    '',
    '[^1]: The note.',
    '',
    '- [x] task',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 < 2 | ~~x~~ |',
  ].join('\n');
  const r = check(body, { files: { 'pages/b.md': FM + '## Part one\n\nx\n', 'assets/flow.png': 'png' } });
  assert.deepEqual(r.findings, []);
  assert.deepEqual([r.contractVersion, r.ok, r.publishable, r.withheld], ['0.2', true, true, []]);
});

const rejects: [string, string, string][] = [
  ['raw HTML', '<div>hi</div>', 'disallowed-syntax'],
  ['script', '<script>alert(1)</script>', 'disallowed-syntax'],
  ['iframe', '<iframe src="https://x.example"></iframe>', 'disallowed-syntax'],
  ['HTML comment', '<!-- hidden -->', 'disallowed-syntax'],
  ['angle-bracket autolink', 'See <https://example.com>.', 'disallowed-syntax'],
  ['email autolink', 'Write to <a@example.com>.', 'disallowed-syntax'],
  ['inline event handler', '<Callout type="note" onclick="x()">\n\nx\n\n</Callout>', 'unknown-attribute'],
  ['unknown component', '<Video src="https://x.example/v.mp4" />', 'unknown-component'],
  ['unknown attribute', '<Operation id="get_stores" color="red" />', 'unknown-attribute'],
  ['unquoted attribute', '<CardGroup cols=2>\n<Card title="a" />\n</CardGroup>', 'invalid-attribute'],
  ['braces for an attribute', '<CardGroup cols={2}>\n<Card title="a" />\n</CardGroup>', 'invalid-attribute'],
  ['single-quoted attribute', "<Operation id='get_stores' />", 'invalid-attribute'],
  ['repeated attribute', '<Operation id="get_stores" id="get_stores" />', 'invalid-attribute'],
  ['bad attribute value', '<Sample operation="get_stores" tryIt="no" />', 'invalid-attribute'],
  ['h1', '# Title', 'heading-h1'],
  ['setext h1', 'Title\n=====', 'heading-h1'],
  ['unknown variable', 'Use {{secret}}.', 'unknown-variable'],
  ['the removed api_key variable', 'Send {{api_key}}.', 'unknown-variable'],
  ['a variable with spaces', 'Use {{ api_name }}.', 'unknown-variable'],
  ['unknown variable in code', '```bash\necho {{nope}}\n```', 'unknown-variable'],
  ['variable used before capture', '<Sample operation="get_stores__storeId_">\n```json\n{ "path": { "storeId": "{{store_id}}" } }\n```\n</Sample>', 'unknown-variable'],
  ['relative link', '[x](../other)', 'link-not-allowed'],
  ['absolute path link', '[x](/reference/op)', 'link-not-allowed'],
  ['http link', '[x](http://example.com)', 'link-not-allowed'],
  ['javascript link', '[x](javascript:alert(1))', 'link-not-allowed'],
  ['external link with userinfo', '[x](https://user@example.com/)', 'link-not-allowed'],
  ['external link with an uppercase host', '[x](https://Example.com/)', 'link-not-allowed'],
  ['external image', '![x](https://example.com/a.png)', 'link-not-allowed'],
  ['anchor on its own', '[x](#part)', 'link-not-allowed'],
  ['link destination in angle brackets', '[x](<op:get_stores>)', 'link-not-allowed'],
  ['unencoded character in a target', '[x](op:get(stores))', 'link-not-allowed'],
  ['unknown operation link', '[x](op:nope)', 'unknown-operation'],
  ['unknown schema', '<Schema ref="Nope" />', 'unknown-schema'],
  ['unknown guide', '[x](guide:nope)', 'unknown-guide'],
  ['unknown anchor', '[x](guide:a#nowhere)', 'unknown-anchor'],
  ['unknown asset', '![x](asset:nope.png)', 'unknown-asset'],
  ['unknown operation in sample', '<Sample operation="nope" />', 'unknown-operation'],
  ['unknown response status', '<Response operation="get_stores" status="418" />', 'unknown-response'],
  ['unknown named example', '<Sample operation="post_stores" example="nope" />', 'unknown-example'],
  ['sample missing required values', '<Sample operation="post_stores">\n```json\n{}\n```\n</Sample>', 'invalid-sample'],
  ['sample body fails schema', '<Sample operation="post_stores">\n```json\n{ "body": { "name": "ab", "currency": "gbp" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with an unknown path parameter', '<Sample operation="get_stores">\n```json\n{ "path": { "nope": "1" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with wrong parameter type', '<Sample operation="get_stores">\n```json\n{ "query": { "limit": 500 } }\n```\n</Sample>', 'invalid-sample'],
  ['sample that sets a header the portal controls', '<Sample operation="get_stores">\n```json\n{ "headers": { "Authorization": "Bearer x" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample that sets a forwarding header', '<Sample operation="get_stores">\n```json\n{ "headers": { "X-Forwarded-For": "1.2.3.4" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with a line break in a header', '<Sample operation="get_stores">\n```json\n{ "headers": { "X-A": "a\\r\\nb" } }\n```\n</Sample>', 'invalid-sample'],
  ['sample with prose inside', '<Sample operation="get_stores">\nhello\n</Sample>', 'invalid-sample'],
  ['bad capture', '<Sample operation="get_stores" capture="x" />', 'invalid-capture'],
  ['capture pairs separated by a comma', '<Sample operation="get_stores" capture="a=$.id,b=$.id" />', 'invalid-capture'],
  ['capture of a built-in name', '<Sample operation="get_stores" capture="base_url=$.id" />', 'invalid-capture'],
  ['capture of a credential name', '<Sample operation="get_stores" capture="api_key=$.id" />', 'invalid-capture'],
  ['a name captured twice', '<Sample operation="get_stores" capture="x=$.id" />\n\n<Sample operation="get_stores" capture="x=$.id" />', 'invalid-capture'],
  ['unclosed component', '<Steps>\n<Step title="a">\n\nx\n\n</Step>', 'unbalanced-component'],
  ['step outside steps', '<Step title="a">\n\nx\n\n</Step>', 'invalid-nesting'],
  ['a component inside a callout', '<Callout>\n\n<Operation id="get_stores" />\n\n</Callout>', 'invalid-nesting'],
  ['steps inside steps', '<Steps>\n<Step title="a">\n<Steps>\n<Step title="b">\n\nx\n\n</Step>\n</Steps>\n</Step>\n</Steps>', 'invalid-nesting'],
  ['a tag with text on its line', 'See <Operation id="get_stores" /> here.', 'invalid-tag-placement'],
  ['a tag without blank lines', 'Text.\n<Operation id="get_stores" />', 'invalid-tag-placement'],
  ['a tag in a list', '- <Operation id="get_stores" />', 'invalid-tag-placement'],
  ['raw HTML after an escaped backslash', 'a \\\\<img src=x onerror=alert(1)>', 'disallowed-syntax'],
  ['raw HTML in a mismatched code span', '`` <img src=x> `', 'disallowed-syntax'],
  ['raw HTML behind escaped backticks', '\\` <img src=x> \\`', 'disallowed-syntax'],
  ['unknown variable after an escaped backslash', '\\\\{{secret}}', 'unknown-variable'],
  ['fence inside a list', '- a\n  ```\n  code\n<img src=x>\n```', 'unsupported-syntax'],
  ['path link with a single-quoted title', "[x](/reference/op 't')", 'link-not-allowed'],
  ['link with nested brackets', '[a [b] c](javascript:alert(1))', 'link-not-allowed'],
  ['link destination on the next line', '[a](\n/reference/op)', 'link-not-allowed'],
  ['link definition in a quote', '[x][r]\n\n> [r]: javascript:alert(1)', 'link-not-allowed'],
  ['link definition split over lines', '[x][r]\n\n[r]:\n/reference/op', 'link-not-allowed'],
  ['h1 in a quote', '> # Title', 'heading-h1'],
  ['h1 in a list', '- # Title', 'heading-h1'],
  ['setext h1 under a code span', '`Title`\n=====', 'heading-h1'],
  ['prose after an opening Sample tag', '<Sample operation="get_stores"> hello\n```json\n{}\n```\n</Sample>', 'invalid-tag-placement'],
  ['bad code info', '```bash onclick="x"\nls\n```', 'invalid-code-info'],
];
for (const [name, body, code] of rejects) {
  test(`rejects ${name}`, () => assert.ok(codes(check(body + '\n')).includes(code), `expected ${code}, got ${codes(check(body + '\n')).join(', ') || 'no errors'}`));
}

test('a named example and inline values can be combined, with one source for the body', () => {
  const museum = loadSpec(readFileSync(join(root, 'fixtures/specs/museum.yaml')));
  const run = (body: string) => {
    const files = new Map<string, Uint8Array>();
    files.set('guides.json', enc.encode(JSON.stringify({ contractVersion: '0.2', generator: { name: 'x', version: '1' }, spec: { sha256: museum.sha256 }, nav: [{ page: 'a' }] })));
    files.set('pages/a.md', enc.encode('---\ntitle: T\ndescription: D\ntype: concept\n---\n\n' + body + '\n'));
    return validateBundle(files, museum, { manifestSchema }).findings.filter((f) => f.severity === 'error').map((f) => `${f.code}: ${f.message}`);
  };
  const op = museum.operations.find((o) => o.requestBody && Object.keys(o.requestBody.examples).length > 0)!;
  const name = Object.keys(op.requestBody!.examples)[0]!;
  const path = Object.fromEntries(op.parameters.filter((p) => p.in === 'path').map((p) => [p.name, '{{x}}']));
  const capture = '<Sample operation="' + museum.operations.find((o) => o.parameters.every((p) => !p.required))!.id + '" capture="x=$.id" />\n\n';
  assert.deepEqual(run(`${capture}<Sample operation="${op.id}" example="${name}">\n\`\`\`json\n${JSON.stringify({ path })}\n\`\`\`\n</Sample>`), []);
  assert.match(run(`${capture}<Sample operation="${op.id}" example="${name}">\n\`\`\`json\n${JSON.stringify({ path, body: {} })}\n\`\`\`\n</Sample>`).join(), /invalid-sample: The named example supplies the request body/);
});

test('frontmatter rules', () => {
  const fm = (yaml: string) => check('x\n', { frontmatter: `---\n${yaml}\n---\n` });
  assert.deepEqual(codes(fm('title: "A {b} <c> [d](e)"\ndescription: D\ntype: concept')), [], 'frontmatter values are literal text');
  assert.ok(codes(check('x\n', { frontmatter: 'no frontmatter\n' })).includes('invalid-frontmatter'));
  assert.ok(codes(fm(`title: ${'t'.repeat(81)}\ndescription: D\ntype: how-to`)).includes('invalid-frontmatter'));
  assert.ok(codes(fm('title: T\ndescription: D\ntype: blog')).includes('invalid-frontmatter'));
  assert.ok(codes(fm('title: T\ndescription: D\ntype: how-to\nlayout: wide')).includes('invalid-frontmatter'));
  assert.ok(codes(fm('title: T\ntitle: U\ndescription: D\ntype: how-to')).includes('invalid-frontmatter'), 'duplicate keys');
  assert.ok(codes(fm('title: &t T\ndescription: *t\ntype: how-to')).includes('invalid-frontmatter'), 'anchors and aliases');
  assert.ok(codes(fm('title: !!str T\ndescription: D\ntype: how-to')).includes('invalid-frontmatter'), 'tags');
  assert.ok(codes(fm('title: 42\ndescription: D\ntype: how-to')).includes('invalid-frontmatter'), 'text only');
  assert.ok(codes(fm('title: T\ndescription: D\ntype: how-to\nstatus: done')).includes('invalid-frontmatter'));
  assert.ok(codes(fm('title: T\ndescription: D\ntype: how-to\noperations: [nope]')).includes('unknown-operation'));
  assert.ok(codes(fm(`title: T\ndescription: D\ntype: how-to\ntags: [${'"x", '.repeat(4000)}"x"]`)).includes('size-limit'));
});

test('manifest and layout rules', () => {
  assert.ok(codes(check('x\n', { nav: [{ page: 'a' }, { page: 'a' }] })).includes('duplicate-page'));
  assert.ok(codes(check('x\n', { nav: [{ page: 'a' }, { page: 'ghost' }] })).includes('missing-page'));
  assert.ok(codes(check('x\n', { nav: [{ page: 'a' }], files: { 'pages/orphan.md': FM + 'x\n' } })).includes('unlisted-page'));
  assert.ok(codes(check('x\n', { nav: [{ page: 'a', extra: 1 }] })).includes('invalid-manifest'));
  assert.ok(codes(check('x\n', { manifest: manifest([{ page: 'a' }]).replace('"0.2"', '"0.1"') })).includes('unsupported-contract-version'));
  const deep = [{ group: '1', items: [{ group: '2', items: [{ group: '3', items: [{ group: '4', items: [{ page: 'a' }] }] }] }] }];
  assert.ok(codes(check('x\n', { nav: deep })).includes('nav-depth'));
  assert.ok(codes(check('x\n', { files: { 'assets/run.exe': 'x' } })).includes('asset-type'));
  assert.ok(codes(check('x\n', { files: { 'assets/Flow.png': 'x' } })).includes('invalid-path'));
  assert.ok(codes(check('x\n', { files: { 'pages/notes.txt': 'x' } })).includes('unexpected-file'));
  assert.ok(codes(check('x\n', { files: { 'README.md': 'x' } })).includes('unexpected-file'));
  assert.ok(codes(check('x\r\n')).includes('invalid-encoding'));
  assert.ok(codes(check('x\n', { frontmatter: '﻿' + FM })).includes('invalid-encoding'));
});

test('the run report is checked and never blocks', () => {
  const good = check('x\n', { files: { 'report.json': JSON.stringify({ pages: [{ page: 'a', outcome: 'written', extra: 1 }], mine: true }) } });
  assert.deepEqual(good.findings, []);
  const bad = check('x\n', { files: { 'report.json': JSON.stringify({ pages: [{ page: 'a', outcome: 'maybe' }] }) } });
  assert.equal(bad.ok, true);
  assert.deepEqual(of(bad, 'warning'), ['invalid-report']);
  assert.deepEqual(of(check('x\n', { files: { 'report.json': '{ nope' } }), 'warning'), ['invalid-report']);
});

test('a blocker withholds its own page, and links to it are reported', () => {
  const todo = FM + '<Todo title="Limits">\n\nSay what the limits are.\n\n</Todo>\n';
  const draft = '---\ntitle: T\ndescription: D\ntype: concept\nstatus: draft\n---\n\nx\n';
  const r = check('See [limits](guide:b) and [draft](guide:c).\n\n<CardGroup>\n<Card title="Limits" href="guide:b" />\n</CardGroup>\n', { files: { 'pages/b.md': todo, 'pages/c.md': draft + '\n[back](guide:b)\n' } });
  assert.deepEqual([r.ok, r.publishable], [true, true]);
  assert.deepEqual(r.withheld, ['b', 'c']);
  assert.deepEqual(of(r, 'blocker').sort(), ['page-not-ready', 'todo-present']);
  const links = r.findings.filter((f) => f.code === 'link-to-withheld-page');
  assert.deepEqual(links.map((f) => [f.file, f.target, f.severity]), [
    ['pages/a.md', 'pages/b.md', 'warning'],
    ['pages/a.md', 'pages/c.md', 'warning'],
    ['pages/a.md', 'pages/b.md', 'warning'],
  ], 'one finding per link, on the linking page; a link between withheld pages is not reported');
});

test('warnings do not block', () => {
  const r = check('![](asset:a.png)\n\n<Operation id="get_reports__reportId_" />\n\n```bash\ncurl -X POST {{base_url}}/stores\n```\n\n<Sample operation="get_stores">\n```json\n{ "query": { "sort": "asc" } }\n```\n</Sample>\n', { frontmatter: '---\ntitle: T\ndescription: D\ntype: quickstart\n---\n', files: { 'assets/a.png': 'x' } });
  assert.equal(r.ok, true);
  assert.deepEqual(of(r, 'warning').sort(), ['api-request-code', 'deprecated-operation', 'image-missing-alt', 'page-unreferenced', 'undeclared-parameter']);
  const concept = check('x\n', { frontmatter: '---\ntitle: T\ndescription: D\ntype: concept\n---\n' });
  assert.deepEqual(concept.findings, [], 'concept pages are exempt from page-unreferenced');
});

test('heading anchors follow the contract', () => {
  assert.equal(headingAnchor('Create a payment (step 2)'), 'create-a-payment-step-2');
  assert.equal(headingAnchor("What's new in v2.1?"), 'whats-new-in-v21');
  assert.equal(headingAnchor('Using {{api_name}}'), 'using-api_name');
  assert.equal(headingAnchor('???'), 'section');
  assert.equal(headingAnchor('Émile `code` and [link](https://x.example)'), 'Émile-code-and-link', 'only A-Z is lowercased');
  const r = check('## Errors\n\n## Errors\n\n[x](guide:a#errors-1)\n');
  assert.deepEqual(codes(r), []);
});

test('capture grammar', () => {
  assert.deepEqual(parseCapture('a=$.id b=$.items[0].id c=$'), { pairs: [['a', '$.id'], ['b', '$.items[0].id'], ['c', '$']], bad: [] });
  for (const bad of ['a=$.id  b=$.id', ' a=$.id', 'A=$.id', "a=$['x']", 'a=$.x-y', 'a=$.items[01]', 'a=$..id']) assert.ok(parseCapture(bad).bad.length > 0, bad);
});

test('operation ids follow the contract, collisions included', () => {
  const ids = (list: [string, string, string?][]) => assignOperationIds(list.map(([method, path, operationId]) => ({ method, path, operationId }))).map((x) => x.id);
  assert.deepEqual(ids([['get', '/payments/{id}']]), ['get_payments__id_']);
  assert.deepEqual(ids([['get', '/']]), ['get_']);
  assert.deepEqual(ids([['post', '/a_b'], ['post', '/a-b']]), ['post_a_b_2', 'post_a_b']);
  assert.deepEqual(ids([['get', '/pets'], ['get', '/animals', 'get_pets']]), ['get_pets_2', 'get_pets']);
  assert.deepEqual(ids([['get', '/b', 'list'], ['get', '/a', 'list']]), ['get_b', 'list']);
  assert.deepEqual(ids([['get', '/a', '']]), ['get_a']);
});

# EZ-DevDocs

Takes an OpenAPI 3.0 or 3.1 specification and produces developer guides: a quickstart, concept pages,
how-to guides and tutorials. It renders nothing. Its only output is a **guides bundle**, a directory
of Markdown files and a JSON manifest, which [EZ-DevPortal](https://github.com/daniel085/ez-devportal)
ingests and displays next to the API reference.

The bundle format is the portal's guides contract, v0.2. A copy is in [`contract/`](./contract).
What the contract could not express, and the assumptions made where it is silent, are recorded in
the portal repository; [`docs/contract-feedback.md`](./docs/contract-feedback.md) links to them.

## Use

Requires Node 22.18 or later. There is no build step; Node runs the TypeScript directly.

```bash
npm install
node src/cli.ts generate path/to/openapi.yaml --out out
node src/cli.ts validate out/guides --spec path/to/openapi.yaml
```

`generate` writes the bundle to `out/guides/`, with its `report.json`, and `out/spec-audit.md` beside
it, and prints a summary. It exits 0 when the bundle passes contract validation, 1 when it does
not, and 2 when the input is unusable.

The spec is read as bytes and is expected to be the **published spec**: the document the portal
publishes, with any accepted spec-doctor fixes applied. Its SHA-256 goes in the manifest unchanged.
The module reads nothing else, uses no network, and puts no clock or randomness in its output: the
same inputs give byte-identical files. `--timestamp` adds `generatedAt` to the manifest for a run by
hand.

### Regenerating over a bundle people have edited

```bash
node src/cli.ts generate path/to/openapi.yaml --out out --existing path/to/current/bundle
```

`--existing` is the bundle as it stands where people edit it. A regeneration never reverts their work:

- **How an edit is recognised.** `report.json` records the SHA-256 of every page the module wrote.
  A page in the existing bundle whose bytes do not match its record was edited by a person. A page
  with no record was added by one.
- **An edited or added page is emitted byte for byte as given.** Nothing is merged into it. The
  report lists it with `kept: "edited"`.
- **A page nobody edited is regenerated**, or removed when the spec no longer supports it.
- **An edited page that no longer fits the spec is still kept**, for example one that names a
  removed operation. The report says so under `gaps`, and validation fails on that page until a
  person fixes it; the module does not hide the error by dropping their text.
- **Navigation.** If `nav` differs from what the module last wrote, it is the person's: their order,
  groups and labels stand, entries for pages that are gone are removed, and new pages are added to
  the group for their type. Otherwise the module orders it.
- **Assets** in the existing bundle are carried over unchanged.
- **With no `report.json` in the existing bundle**, nothing can be told apart, so every existing
  page is kept. Leave `--existing` out to generate in full.

As a library, with no file access:

```ts
import { generate } from 'ez-devdocs';
const { files, manifest, report, validation, auditMarkdown } = generate(specBytes, { manifestSchema, reportSchema, existing });
```

## What it produces

| Page | Produced when |
|---|---|
| `quickstart` | Always, if the spec has an operation. Credentials, authentication, one call, the response. |
| `authentication` | The spec declares a security scheme. |
| `errors` | Any operation documents a 4xx, 5xx or `default` response. |
| `pagination` | List operations take cursor, offset or page parameters. |
| `idempotency` | An operation takes an idempotency key, in a header or as a field of its request body. |
| `rate-limits` | The spec documents a 429 response or a rate limit header. |
| `webhooks` | The spec has `webhooks` or callbacks. |
| `<resource>/manage` | A resource can be created, and the new identifier can be carried into retrieve, update or delete. |
| `<resource>/browse` | A resource cannot be created but can be listed and then retrieved. |
| `tutorials/<parent>-<child>` | A collection is nested under a resource: create the parent, then work inside it. |

How-to guides and tutorials are flows. The first call captures an identifier from its response and
every later call uses it, so a guide never repeats what the reference already says about one endpoint.

A request body can also refer to another record by identifier, such as `customer_id` on a site. When
the field has the name of the path parameter of a resource the spec can create, the guide creates
that record first, captures its identifier and sends it in place of the example value. Up to five
such steps are added to a page, each one after whatever its own body needs. A field that matches
nothing keeps its example value and is listed as a gap in the report.

## Rules it holds itself to

- **No request code.** Every call is a `<Sample>`. The portal writes the code.
- **Identifiers, not URLs.** Operations, schemas and guides are linked with `op:`, `schema:` and `guide:`.
- **Valid values.** Every inline sample value is checked against the operation's schema before it is
  written. Named examples from the spec are used first, then `example`, `default` and `enum` values,
  then placeholders built from the type. A sample that cannot be made valid is not emitted.
- **No invention.** Prose comes from the spec. Where the spec is silent the page says less, and the
  gap goes in the report for a person to fill.
- **Spec text is untrusted.** Descriptions are reduced to plain text and escaped. HTML, links and
  braces in a description never reach a page as active syntax.
- **Deterministic.** Slugs, navigation and page content depend only on the spec.
- **Checked before it leaves.** The bundle is validated against the contract. A generated page that
  fails is left out and reported, and the rest of the bundle is rebuilt without links to it. The
  module never writes a `<Todo>` or a `draft` page, so it never causes a page to be withheld.

## Weak specs

| Problem | Behavior |
|---|---|
| No `operationId` | Derived by the contract's rule (section 1.1): method, then the path with every character outside `A-Z a-z 0-9` as `_`, with `_2`, `_3` on a collision. Reported. |
| Duplicate `operationId` | One operation keeps it; each other gets a derived id, by the contract's rule (section 1.1). Reported. |
| No examples | Values are built from schemas. Pages that use made-up values are flagged `placeholderValues` in the report. |
| Path parameter with no example and no earlier call that yields it | The guide is skipped, with the reason. An identifier is never guessed. |
| No documented errors, security, pagination | The page is skipped, with the reason. |
| Deprecated operations | Not used in guides. |
| Swagger 2.0, unparseable input | Refused with an error. |

## Specs served in pieces

Some APIs do not publish one OpenAPI file. `scripts/fetch-retavon-spec.mjs` assembles one for the
Retavon API from its per-operation and per-schema reads; it needs an API key in `RETAVON_API_KEY`.
The assembled document belongs to the API's owner and is not kept in this repository.

## The report

`report.json` is part of the bundle, in the shape the contract gives it (section 5.2): `pages`, each
written or skipped with the reason; `gaps`, what a person should complete; and `specProblems`. The
module's own detail rides along as extra members, which the contract allows: each written page's
type, title, operations and SHA-256, and for each spec problem its code, severity, counts, fix and
up to 200 affected operations.

## The spec audit

Every run also audits the spec and writes `spec-audit.md` for whoever owns it: what to change in
the API description so that better guides can be generated. It sits beside the bundle, not in it.
The same findings are in `report.json` under `specProblems`.

| Finding | Severity |
|---|---|
| No server URL; unresolved `$ref`; no success response; a required security scheme that is not defined | high |
| Operations that declare no error response | high when half or more do, else medium |
| No `operationId`, or one used more than once; no summary or description; a GET whose response has no schema; path parameters and request bodies with no example; a create response that does not show the new identifier; security schemes no operation requires | medium |
| Parameters or security schemes with no description; the same body under several success statuses | low |

High means pages are missing or wrong because of it, medium that pages say less, low is polish. The
audit reads only standard OpenAPI. Where operations without error responses carry an extension
field named like one for errors, it says so, since tools that read the standard do not see it. It
does not judge the API's design or behavior, and it cannot see what only a person can, such as
whether the security scheme's description says where credentials are issued.

## Layout

```
src/spec.ts       parse and normalize the spec, hash it
src/values.ts     build sample values from schemas, validate them
src/analyze.ts    resources, identifiers in responses, pagination, errors, rate limits
src/pages.ts      one generator per page type
src/generate.ts   orchestration, manifest, report
src/audit.ts      what the spec's owner should fix
src/validate.ts   contract validator
src/text.ts       sanitizing spec text
src/cli.ts        the only file that touches the file system
```

## Tests

```bash
npm test
npm run typecheck
```

The suite generates a bundle from every spec in `fixtures/specs/`, checks it is valid and identical
across runs, and checks that the validator rejects each kind of contract violation. See
[`fixtures/specs/README.md`](./fixtures/specs/README.md) for the specs and how to add Stripe and GitHub.

## Limits of this version

- Guides are built from templates and the spec's own words. There is no LLM step, so prose is plain
  and how-to guides cover resource lifecycles and nested resources only.
- Resources are found from path shape (`/things` and `/things/{id}`). APIs that are not shaped that
  way get a quickstart and concept pages but few how-to guides.
- Only local `$ref`s are followed. Multi-file specs must be bundled first.
- Request bodies other than JSON and form-encoded are not sampled.
- OpenAPI 3.2 is read as 3.1 and reported as untested.
- The validator scans pages line by line; it is not a full CommonMark parser. Where it cannot be
  sure, it rejects: code blocks must start at the left margin (not inside lists or quotes), tags and
  link destinations must fit on one line, and indented code blocks are read as prose. It is therefore
  stricter than the contract on hand-written bundles. The check for hand-written request code is a
  heuristic (`curl`, `wget`, or an HTTP client called against `{{base_url}}`).

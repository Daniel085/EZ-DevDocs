# EZ-DevDocs

Takes an OpenAPI 3.0 or 3.1 specification and produces developer guides: a quickstart, concept pages,
how-to guides and tutorials. It renders nothing. Its only output is a **guides bundle**, a directory
of Markdown files and a JSON manifest, which [EZ-DevPortal](https://github.com/daniel085/ez-devportal)
ingests and displays next to the API reference.

The bundle format is the portal's guides contract, v0.1. A copy is in [`contract/`](./contract).
What the contract could not express, and the assumptions made where it is silent, are in
[`docs/contract-feedback.md`](./docs/contract-feedback.md).

## Use

Requires Node 22.18 or later. There is no build step; Node runs the TypeScript directly.

```bash
npm install
node src/cli.ts generate path/to/openapi.yaml --out out
node src/cli.ts validate out/guides --spec path/to/openapi.yaml
```

`generate` writes `out/guides/` (the bundle) and `out/report.json`, and prints a summary. It exits 0
when the bundle passes contract validation, 1 when it does not, and 2 when the input is unusable.
`--no-timestamp` leaves `generatedAt` out of the manifest, which makes the output byte-identical
from run to run.

As a library, with no file access:

```ts
import { generate } from 'ez-devdocs';
const { files, manifest, report } = generate(specBytes, { manifestSchema });
```

## What it produces

| Page | Produced when |
|---|---|
| `quickstart` | Always, if the spec has an operation. Credentials, authentication, one call, the response. |
| `authentication` | The spec declares a security scheme. |
| `errors` | Any operation documents a 4xx, 5xx or `default` response. |
| `pagination` | List operations take cursor, offset or page parameters. |
| `idempotency` | An operation takes an idempotency header. |
| `rate-limits` | The spec documents a 429 response or a rate limit header. |
| `webhooks` | The spec has `webhooks` or callbacks. |
| `<resource>/manage` | A resource can be created, and the new identifier can be carried into retrieve, update or delete. |
| `<resource>/browse` | A resource cannot be created but can be listed and then retrieved. |
| `tutorials/<parent>-<child>` | A collection is nested under a resource: create the parent, then work inside it. |

How-to guides and tutorials are flows. The first call captures an identifier from its response and
every later call uses it, so a guide never repeats what the reference already says about one endpoint.

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
- **Checked before it leaves.** The bundle is validated against the contract. A page that fails is
  withheld and reported, and the rest of the bundle is rebuilt without links to it.

## Weak specs

| Problem | Behavior |
|---|---|
| No `operationId` | Derived as the portal does: method, then the path with every non-alphanumeric character as `_`. Reported. |
| Duplicate `operationId` | The first is kept. Later ones are ignored and reported. |
| No examples | Values are built from schemas. Pages that use made-up values are flagged `placeholderValues` in the report. |
| Path parameter with no example and no earlier call that yields it | The guide is skipped, with the reason. An identifier is never guessed. |
| No documented errors, security, pagination | The page is skipped, with the reason. |
| Deprecated operations | Not used in guides. |
| Swagger 2.0, unparseable input | Refused with an error. |

## The report

`report.json` lists, per run: the pages produced and their operations, everything skipped and why,
the gaps a person should complete, problems found in the spec, and the contract validation result.

## Layout

```
src/spec.ts       parse and normalize the spec, hash it
src/values.ts     build sample values from schemas, validate them
src/analyze.ts    resources, identifiers in responses, pagination, errors, rate limits
src/pages.ts      one generator per page type
src/generate.ts   orchestration, manifest, report
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

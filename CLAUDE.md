# EZ-DevDocs

Generates a guides bundle from an OpenAPI 3.x spec, for EZ-DevPortal. Read `README.md` first, then
`contract/guides-contract.md`, which defines the output format.

## Standing constraints

- The contract in `contract/` is owned by the portal repository (`docs/contracts/`). Do not edit the
  copy here except to re-sync it. If it cannot express something, do not work around it. Record it
  in the portal repository, in `docs/contracts/guides-contract-feedback.md`. That is the only copy
  of the feedback; `docs/contract-feedback.md` here just links to it. Portal sessions cannot read
  this repository, so update `docs/contracts/guides-module-status.md` there too when what this
  module emits changes.
- Never emit API request code. Calls are `<Sample>` components.
- Spec text is untrusted. Everything taken from a spec goes through `src/text.ts`.
- Do not invent facts about an API. If the spec does not say it, leave it out and add a gap to the report.
- The same spec must give the same slugs, navigation and page bytes.
- Only `src/cli.ts` touches the file system. Everything else is pure.
- Erasable TypeScript only (no enums or parameter properties); Node runs the source directly.

## Agents

One agent is defined in `.claude/agents/`.

| Agent | Engage when |
|---|---|
| `ia-reviewer` | After any change to which pages are generated, to slugs, titles or navigation, or to how resources are detected. Before generation work is called done. |

Give it the task and let it generate and read bundles itself. Do not hand it a summary of the
change or of what the output looks like.

## Before calling work done

`npm test` and `npm run typecheck` pass. For changes to generation, also run against Stripe and
GitHub (`scripts/fetch-large-specs.sh`) and read a sample of the pages, not just the validation result.
For changes to pages, slugs or navigation, the `ia-reviewer` has reviewed the output.

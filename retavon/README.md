# Retavon

Work specific to generating guides for the Retavon API. This directory lives on the branch
`claude/sharp-pascal-a7vqwn` only; nothing here is on `main`.

| File | What it is |
|---|---|
| [`audit.md`](./audit.md) | The audit to send to Retavon: what to change in their API description, and why. |
| [`spec-audit.generated.md`](./spec-audit.generated.md) | The generator's own audit of the run of 2026-11-28, with every feature on, unedited. |
| [`settings.json`](./settings.json) | What to do with each of Retavon's twelve vendor extensions when generating: which are permissions, which a requirement, which a note, which to ignore. |
| [`run-results.json`](./run-results.json) | Which generated guides worked when run against a Retavon business on 2026-11-28, and why the others did not. |

Retavon's OpenAPI document and the generated bundle are not kept here. To make them again:

```bash
RETAVON_API_KEY=... node scripts/fetch-retavon-spec.mjs out/retavon-spec
node src/cli.ts generate out/retavon-spec/retavon-openapi.json --out out/retavon --settings retavon/settings.json
```

That writes the bundle under `out/retavon/guides`, with its `report.json`, and a fresh
`spec-audit.md` beside it. To run the guides against a business that is safe to write to:

```bash
node scripts/run-guides.ts out/retavon/guides --spec out/retavon-spec/retavon-openapi.json --vary
```

Skip pages that reach outside the business (email, text, card charges, keys, feedback) with `--skip`.

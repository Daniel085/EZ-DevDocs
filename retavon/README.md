# Retavon

Work specific to generating guides for the Retavon API. This directory lives on the branch
`claude/sharp-pascal-a7vqwn` only; nothing here is on `main`.

| File | What it is |
|---|---|
| [`audit.md`](./audit.md) | The audit to send to Retavon: what to change in their API description, and why. |
| [`spec-audit.generated.md`](./spec-audit.generated.md) | The generator's own audit of the run of 2026-11-27, unedited. `audit.md` is built on it. |

Retavon's OpenAPI document and the generated bundle are not kept here. To make them again:

```bash
RETAVON_API_KEY=... node scripts/fetch-retavon-spec.mjs out/retavon-spec
node src/cli.ts generate out/retavon-spec/retavon-openapi.json --out out/retavon
```

That writes the bundle, `report.json` and a fresh `spec-audit.md` under `out/retavon`.

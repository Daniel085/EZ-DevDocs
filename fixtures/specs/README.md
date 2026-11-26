# Fixture specs

The test suite generates and validates a bundle from every spec in this directory. Files are
byte-for-byte copies; do not reformat them, since the spec hash is part of the output.

| File | Source | Why it is here |
|---|---|---|
| `petstore.yaml` | [swagger-api/swagger-petstore](https://github.com/swagger-api/swagger-petstore) (Apache-2.0) | Small OpenAPI 3.0, average quality, few examples |
| `museum.yaml` | [Redocly/museum-openapi-example](https://github.com/Redocly/museum-openapi-example) (MIT) | Small OpenAPI 3.1, good quality, named examples, webhooks |
| `clubhouse.json` | [APIs.guru](https://apis.guru) `clubhouseapi.com` (CC0) | Weak OpenAPI 3.0: no operationIds, no security schemes, sparse responses |
| `synthetic-orders.yaml` | Written for this project | Hostile descriptions (HTML, braces), nested resources, cursor pagination, idempotency |

Large specs are not committed. `scripts/fetch-large-specs.sh` downloads Stripe (612 operations) and
GitHub Enterprise Server (908 operations); set `EZ_DEVDOCS_EXTRA_SPECS` to that directory to include
them in `npm test`.

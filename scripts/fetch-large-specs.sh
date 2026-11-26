#!/usr/bin/env bash
# Downloads large public specs for testing at scale. Usage: scripts/fetch-large-specs.sh <dir>
set -euo pipefail
dir="${1:?usage: fetch-large-specs.sh <dir>}"
mkdir -p "$dir"
curl -fsSL -o "$dir/stripe.json" https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
curl -fsSL -o "$dir/github-ghes.json" https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/ghes-3.9/ghes-3.9.json
echo "Run: EZ_DEVDOCS_EXTRA_SPECS=$dir npm test"

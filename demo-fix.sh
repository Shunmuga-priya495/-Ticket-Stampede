#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results

URL="${URL:-http://localhost:3001}"
echo "Running the same high-contention load test against the CORRECTED server at $URL"
echo "(start it first with: scripts/start-server.sh)"
echo ""

node load-test/load-test.js \
  --tickets 100 \
  --concurrency 1000 \
  --requests 20000 \
  --duplicates 20 \
  --url "$URL" \
  --out results/corrected-pass.txt

echo ""
echo "Evidence saved to results/corrected-pass.txt"

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results

URL="${URL:-http://localhost:3000}"
echo "Running high-contention load test against NAIVE server at $URL"
echo "(start it first with: scripts/start-naive.sh)"
echo ""

# High contention on purpose: 100 tickets, 1000 concurrent buyers, 20000
# total requests, 20% deliberately-replayed request_ids. This is the
# scenario most likely to expose the naive implementation's race window.
node load-test/load-test.js \
  --tickets 100 \
  --concurrency 1000 \
  --requests 20000 \
  --duplicates 20 \
  --url "$URL" \
  --out results/naive-failure.txt

echo ""
echo "Evidence saved to results/naive-failure.txt"

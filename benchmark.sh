#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results

URL="${URL:-http://localhost:3001}"
LEVELS="${LEVELS:-10 50 100 500 1000}"
TICKETS="${TICKETS:-2000}"
REQUESTS="${REQUESTS:-10000}"

OUT=results/benchmark.csv
echo "concurrency,requests,tickets,rps,median_ms,p99_ms,successes,sold_out,errors" > "$OUT"

echo "Benchmarking corrected server at $URL"
echo "(start it first with: scripts/start-server.sh)"
echo ""

for C in $LEVELS; do
  echo "--- concurrency=$C ---"
  RAW=$(node load-test/load-test.js \
    --tickets "$TICKETS" \
    --concurrency "$C" \
    --requests "$REQUESTS" \
    --duplicates 5 \
    --url "$URL" || true)

  echo "$RAW"

  RPS=$(echo "$RAW" | grep 'Requests/sec:' | awk '{print $2}')
  MEDIAN=$(echo "$RAW" | grep 'Median latency:' | awk '{print $3}' | tr -d 'ms')
  P99=$(echo "$RAW" | grep 'P99 latency:' | awk '{print $3}' | tr -d 'ms')
  SUCCESS=$(echo "$RAW" | grep 'Successful purchases:' | awk '{print $3}')
  SOLDOUT=$(echo "$RAW" | grep 'Sold-out responses:' | awk '{print $3}')
  ERRORS=$(echo "$RAW" | grep 'Errors:' | head -1 | awk '{print $2}')

  echo "$C,$REQUESTS,$TICKETS,$RPS,$MEDIAN,$P99,$SUCCESS,$SOLDOUT,$ERRORS" >> "$OUT"
done

echo ""
echo "Results written to $OUT"
cat "$OUT"

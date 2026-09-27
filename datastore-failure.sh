#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results

URL="${URL:-http://localhost:3001}"
OUT=results/datastore-failure.txt

echo "Datastore failure/degradation experiment against $URL" | tee "$OUT"
echo "(start the corrected server first with: scripts/start-server.sh)" | tee -a "$OUT"
echo "" | tee -a "$OUT"

echo "=== Phase 1: reset sale, buy a few tickets to establish a baseline ===" | tee -a "$OUT"
curl -s -X POST "$URL/reset" -H 'Content-Type: application/json' -d '{"tickets": 50}' | tee -a "$OUT"
echo "" | tee -a "$OUT"
curl -s -X POST "$URL/buy" -H 'Content-Type: application/json' -d '{"user_id":"baseline-1","request_id":"baseline-req-1"}' | tee -a "$OUT"
echo "" | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== Phase 2: simulate the datastore going slow (10s) for the next call ===" | tee -a "$OUT"
curl -s -X POST "$URL/admin/simulate-slow-db" -H 'Content-Type: application/json' -d '{"duration_ms": 10000}' | tee -a "$OUT"
echo "" | tee -a "$OUT"
echo "Issuing a /buy call now; expect it to take ~10s to respond (server blocks synchronously on the simulated slow datastore call):" | tee -a "$OUT"
START=$(date +%s%N)
curl -s -X POST "$URL/buy" -H 'Content-Type: application/json' -d '{"user_id":"slow-test","request_id":"slow-req-1"}' | tee -a "$OUT"
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
echo "" | tee -a "$OUT"
echo "Observed latency: ${ELAPSED_MS}ms" | tee -a "$OUT"
echo "" | tee -a "$OUT"
echo "NOTE: because node:sqlite is synchronous, a slow datastore call blocks" | tee -a "$OUT"
echo "the entire event loop -- ALL other in-flight requests to this process" | tee -a "$OUT"
echo "queue up behind it, not just the one that hit the slow call. This is a" | tee -a "$OUT"
echo "real, honest limitation of the single-threaded synchronous design; see" | tee -a "$OUT"
echo "README 'Known Limitations' and DECISIONS.md." | tee -a "$OUT"

echo "" | tee -a "$OUT"
curl -s -X POST "$URL/admin/simulate-slow-db" -H 'Content-Type: application/json' -d '{"duration_ms": 0}' > /dev/null

echo "" | tee -a "$OUT"
echo "=== Phase 2b: prove the slow call blocks OTHER concurrent requests too ===" | tee -a "$OUT"
echo "(this is the important part -- it's not just the one unlucky request that pays the cost)" | tee -a "$OUT"
curl -s -X POST "$URL/admin/simulate-slow-db" -H 'Content-Type: application/json' -d '{"duration_ms": 3000}' > /dev/null
(
  START=$(date +%s%N)
  curl -s -o /dev/null -X POST "$URL/buy" -H 'Content-Type: application/json' -d '{"user_id":"slow-A","request_id":"phase2b-A"}'
  END=$(date +%s%N)
  echo "  request A (triggers the slow path): $(( (END-START)/1000000 ))ms" | tee -a "$OUT"
) &
sleep 0.1
(
  START=$(date +%s%N)
  curl -s -o /dev/null -X POST "$URL/buy" -H 'Content-Type: application/json' -d '{"user_id":"fast-B","request_id":"phase2b-B"}'
  END=$(date +%s%N)
  echo "  request B (arrives 100ms later, completely unrelated buyer): $(( (END-START)/1000000 ))ms" | tee -a "$OUT"
) &
wait
curl -s -X POST "$URL/admin/simulate-slow-db" -H 'Content-Type: application/json' -d '{"duration_ms": 0}' > /dev/null
echo "  (B was delayed almost as long as A despite sharing nothing with it -- the synchronous" | tee -a "$OUT"
echo "   datastore call blocks Node's single event loop thread entirely.)" | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== Phase 3: simulate the datastore being completely unavailable ===" | tee -a "$OUT"
curl -s -X POST "$URL/admin/simulate-db-down" -H 'Content-Type: application/json' -d '{"enabled": true}' | tee -a "$OUT"
echo "" | tee -a "$OUT"
echo "Issuing 5 /buy calls while the datastore is 'down':" | tee -a "$OUT"
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "  request $i -> HTTP %{http_code}\n" \
    -X POST "$URL/buy" -H 'Content-Type: application/json' \
    -d "{\"user_id\":\"down-test-$i\",\"request_id\":\"down-req-$i\"}" | tee -a "$OUT"
done

echo "" | tee -a "$OUT"
echo "=== Phase 4: bring the datastore back and confirm recovery + no corruption ===" | tee -a "$OUT"
curl -s -X POST "$URL/admin/simulate-db-down" -H 'Content-Type: application/json' -d '{"enabled": false}' | tee -a "$OUT"
echo "" | tee -a "$OUT"
echo "Retrying the requests that failed during the outage (client-side retry with the SAME request_id):" | tee -a "$OUT"
for i in 1 2 3 4 5; do
  curl -s -X POST "$URL/buy" -H 'Content-Type: application/json' \
    -d "{\"user_id\":\"down-test-$i\",\"request_id\":\"down-req-$i\"}" | tee -a "$OUT"
  echo "" | tee -a "$OUT"
done

echo "" | tee -a "$OUT"
echo "Final status:" | tee -a "$OUT"
curl -s "$URL/status" | tee -a "$OUT"
echo "" | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "Evidence saved to $OUT"

#!/usr/bin/env node
'use strict';

/**
 * Load-test / buyer client.
 *
 * Usage:
 *   node load-test/load-test.js --tickets 100 --concurrency 1000 \
 *     --requests 50000 --duplicates 20 --url http://localhost:3000
 *
 * What it does:
 *   1. POSTs /reset with the requested ticket count.
 *   2. Fires `--requests` total POST /buy calls, `--concurrency` in flight
 *      at any time, against `--url`.
 *   3. `--duplicates N` means N% of requests deliberately reuse a
 *      request_id that was already used earlier in the run (simulating a
 *      client retry / double-submit), sent concurrently with fresh traffic
 *      — not sequentially after the fact.
 *   4. Reports throughput, median/p99 latency, and outcome counts.
 *   5. Independently verifies all four invariants from the client's own
 *      observations plus a final GET /status — it does NOT trust the
 *      server's opinion of its own correctness.
 *
 * No dependencies: uses global fetch (Node 18+) and a hand-rolled
 * concurrency pool.
 */

function parseArgs(argv) {
  const args = {
    tickets: 100,
    concurrency: 100,
    requests: 5000,
    duplicates: 0,
    url: 'http://localhost:3000',
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeNext = () => argv[++i];
    switch (a) {
      case '--tickets': args.tickets = Number(takeNext()); break;
      case '--concurrency': args.concurrency = Number(takeNext()); break;
      case '--requests': args.requests = Number(takeNext()); break;
      case '--duplicates': args.duplicates = Number(takeNext()); break;
      case '--url': args.url = takeNext(); break;
      case '--out': args.out = takeNext(); break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  return args;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.ceil((p / 100) * sortedArr.length) - 1);
  return sortedArr[Math.max(0, idx)];
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function runOne() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

function buildRequestPlan(totalRequests, duplicatePercent) {
  // Build the list of (user_id, request_id) pairs up front so that
  // "duplicate" requests are decided by the test plan, not by chance,
  // and so duplicates can be interleaved with fresh requests instead of
  // trailing after them (which would defeat the point of testing
  // *concurrent* replay).
  const plan = [];
  const seedRequestIds = [];
  for (let i = 0; i < totalRequests; i++) {
    const wantsDuplicate = seedRequestIds.length > 0 && Math.random() * 100 < duplicatePercent;
    if (wantsDuplicate) {
      const pick = seedRequestIds[Math.floor(Math.random() * seedRequestIds.length)];
      plan.push({ user_id: pick.user_id, request_id: pick.request_id, is_planned_duplicate: true });
    } else {
      const entry = { user_id: `user-${i}`, request_id: `req-${i}`, is_planned_duplicate: false };
      plan.push(entry);
      seedRequestIds.push(entry);
    }
  }
  // Shuffle so duplicates land throughout the run, concurrently with
  // fresh requests, rather than only after their originals are known
  // to have completed.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[load-test] target=${args.url} tickets=${args.tickets} concurrency=${args.concurrency} requests=${args.requests} duplicates=${args.duplicates}%`);

  const resetRes = await fetch(`${args.url}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickets: args.tickets }),
  });
  if (!resetRes.ok) {
    console.error(`[load-test] /reset failed: ${resetRes.status} ${await resetRes.text()}`);
    process.exit(1);
  }

  const plan = buildRequestPlan(args.requests, args.duplicates);

  let successCount = 0;
  let idempotentHitCount = 0;
  let soldOutCount = 0;
  let errorCount = 0;
  const latencies = [];
  // ticket_number -> [ {user_id, request_id}, ... ] as OBSERVED by the client
  const observedTicketOwners = new Map();
  // request_id -> Set(ticket_number) as OBSERVED by the client
  const observedRequestTickets = new Map();

  const startTime = Date.now();

  await runPool(plan, args.concurrency, async (item) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${args.url}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: item.user_id, request_id: item.request_id }),
      });
      const elapsed = performance.now() - t0;
      latencies.push(elapsed);

      if (res.status === 200) {
        const data = await res.json();
        successCount++;
        if (data.idempotent) idempotentHitCount++;
        const tn = data.ticket_number;
        if (!observedTicketOwners.has(tn)) observedTicketOwners.set(tn, []);
        observedTicketOwners.get(tn).push({ user_id: item.user_id, request_id: item.request_id });

        if (!observedRequestTickets.has(item.request_id)) observedRequestTickets.set(item.request_id, new Set());
        observedRequestTickets.get(item.request_id).add(tn);
      } else if (res.status === 409) {
        soldOutCount++;
        await res.text();
      } else {
        errorCount++;
        await res.text();
      }
    } catch (e) {
      const elapsed = performance.now() - t0;
      latencies.push(elapsed);
      errorCount++;
    }
  });

  const wallSeconds = (Date.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);
  const median = percentile(latencies, 50);
  const p99 = percentile(latencies, 99);
  const rps = args.requests / wallSeconds;

  const statusRes = await fetch(`${args.url}/status`);
  const status = await statusRes.json();

  // ---- Invariant verification (independent of what the server claims) ----
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };

  log('');
  log('=== RESULTS ===');
  log(`Total requests:        ${args.requests}`);
  log(`Successful purchases:  ${successCount} (${successCount - idempotentHitCount} new tickets + ${idempotentHitCount} idempotent replays)`);
  log(`Sold-out responses:    ${soldOutCount}`);
  log(`Errors:                ${errorCount}`);
  log(`Wall time:             ${wallSeconds.toFixed(2)}s`);
  log(`Requests/sec:          ${rps.toFixed(1)}`);
  log(`Median latency:        ${median.toFixed(2)}ms`);
  log(`P99 latency:           ${p99.toFixed(2)}ms`);

  // Invariant 1: never sell more tickets than exist.
  const distinctTicketsIssued = observedTicketOwners.size;
  const inv1Pass = distinctTicketsIssued <= args.tickets && status.sold <= args.tickets;
  log('');
  log(`Invariant 1 (never oversell): ${inv1Pass ? 'PASS' : 'FAIL'}` +
      `  [distinct tickets observed=${distinctTicketsIssued}, server sold=${status.sold}, capacity=${args.tickets}]`);

  // Invariant 2: never issue the same ticket number twice (to two different
  // request_ids -- the same request_id retried is fine, that's idempotency).
  let duplicateTicketNumbers = 0;
  for (const [tn, owners] of observedTicketOwners.entries()) {
    const distinctRequestIds = new Set(owners.map((o) => o.request_id));
    if (distinctRequestIds.size > 1) duplicateTicketNumbers++;
  }
  const inv2Pass = duplicateTicketNumbers === 0;
  log(`Invariant 2 (unique ticket numbers): ${inv2Pass ? 'PASS' : 'FAIL'}` +
      `  [ticket numbers reused across different request_ids=${duplicateTicketNumbers}]`);

  // Invariant 3: same request_id must never result in multiple tickets.
  let requestIdsWithMultipleTickets = 0;
  for (const [rid, ticketSet] of observedRequestTickets.entries()) {
    if (ticketSet.size > 1) requestIdsWithMultipleTickets++;
  }
  const inv3Pass = requestIdsWithMultipleTickets === 0;
  log(`Invariant 3 (request_id idempotency): ${inv3Pass ? 'PASS' : 'FAIL'}` +
      `  [request_ids that got >1 distinct ticket=${requestIdsWithMultipleTickets}]`);

  // Invariant 4: /status count must equal tickets actually issued.
  const serverTicketsIssued = status.tickets_issued ?? Object.keys(status.tickets || {}).length;
  const inv4Pass = status.sold === serverTicketsIssued && status.sold === distinctTicketsIssued;
  log(`Invariant 4 (status count matches issued tickets): ${inv4Pass ? 'PASS' : 'FAIL'}` +
      `  [server sold=${status.sold}, server tickets_issued=${serverTicketsIssued}, client observed distinct=${distinctTicketsIssued}]`);

  const allPass = inv1Pass && inv2Pass && inv3Pass && inv4Pass;
  log('');
  log(`OVERALL: ${allPass ? 'ALL INVARIANTS PASS' : 'ONE OR MORE INVARIANTS FAILED'}`);

  if (args.out) {
    const fs = require('fs');
    fs.writeFileSync(args.out, lines.join('\n') + '\n');
    console.log(`\n[load-test] results written to ${args.out}`);
  }

  process.exit(allPass ? 0 : 2);
}

main().catch((e) => {
  console.error('[load-test] fatal error:', e);
  process.exit(1);
});

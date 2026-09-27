# -Ticket-Stampede
# Ticket Stampede

A ticket-selling API that stays correct under heavy concurrent load: no
overselling, no duplicate ticket numbers, and safe retries via
`request_id` idempotency — demonstrated by deliberately breaking a naive
implementation first, then fixing it, then load-testing the fix.

## Problem

Selling a fixed number of tickets to many concurrent buyers is a classic
race-condition trap. A naive "check remaining, then issue" implementation
looks correct in manual testing and fails silently under load: it oversells,
issues duplicate ticket numbers, or double-charges a buyer whose client
retried a timed-out request. This repo builds both versions, proves the
naive one fails with real load-test evidence, and proves the fix holds.

## Architecture

- One HTTP process, built on Node's built-in `http` module (no
  Express/Fastify — three routes don't need a framework).
- One SQLite database file per server, via Node's built-in `node:sqlite`
  (`DatabaseSync`) — synchronous, transactional, zero npm dependencies.
- Correctness comes from combining two things:
  1. **SQLite transactions** (`BEGIN IMMEDIATE ... COMMIT`) around the
     read-check-write sequence in `/buy`, plus a `UNIQUE` constraint on
     `request_id`.
  2. **Node's single-threaded, synchronous execution** — because
     `node:sqlite` calls never `await`, nothing else can run on the event
     loop in the middle of a `/buy` transaction. There is no interleaving
     window for another request to land in.

See `DECISIONS.md` for the full reasoning, including what would break if
this ran as multiple processes.

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | Node.js 22 | Built-in `node:sqlite`, built-in `fetch`, built-in test runner — a full stack with **zero `npm install`** |
| HTTP | Node's built-in `http` module | 3 routes; a framework buys nothing here |
| Datastore | SQLite (`node:sqlite`, `DatabaseSync`) | Real ACID transactions and `UNIQUE` constraints, synchronous API (no accidental interleaving), no server process to install |
| Testing | `node:test` (built-in) | No dependency, runs with `node --test` |
| Load testing | Custom Node script (`load-test/load-test.js`) | Full control over concurrency, duplicate-replay injection, and independent invariant verification; uses global `fetch`, no dependency |

## Project Structure

```
ticket-stampede/
├── src/
│   ├── naive-server.js     # intentionally racy implementation
│   ├── server.js           # corrected implementation
│   └── http-helpers.js     # shared tiny HTTP router/JSON helpers
├── tests/
│   └── corrected.test.js   # automated invariant tests (node:test)
├── load-test/
│   └── load-test.js        # concurrency load client + invariant verifier
├── scripts/
│   ├── start-naive.sh
│   ├── start-server.sh
│   ├── run-tests.sh
│   ├── break-naive.sh      # runs the naive-failure demonstration
│   ├── demo-fix.sh         # runs the same load against the fix
│   ├── benchmark.sh        # concurrency sweep
│   └── datastore-failure.sh
├── results/                # real, captured evidence (not fabricated)
│   ├── naive-failure.txt
│   ├── corrected-pass.txt
│   ├── benchmark.csv
│   └── datastore-failure.txt
├── logs/                   # AI coding session transcripts
├── README.md
└── DECISIONS.md
```

## Prerequisites

- Node.js **22.5.0 or later** (for `node:sqlite`). Check with `node --version`.
- No `npm install` required — the project has zero dependencies.

## Installation

```bash
git clone <this-repo>
cd ticket-stampede
node --version   # confirm >= 22.5.0
```

That's it.

## Running the Seller

Naive (broken) version, on port 3000:

```bash
scripts/start-naive.sh
# or: PORT=3000 node src/naive-server.js
```

Corrected version, on port 3001:

```bash
scripts/start-server.sh
# or: PORT=3001 node src/server.js
```

The corrected server keeps its data in `data.sqlite` in the repo root;
`start-server.sh` deletes any previous copy so each run starts clean.

## API Endpoints

### POST /reset

Clears all state and starts a fresh sale with the given ticket count.

Request:
```json
{ "tickets": 100 }
```

Response:
```json
{ "ok": true, "total": 100 }
```

### POST /buy

Request:
```json
{ "user_id": "alice", "request_id": "req-abc-123" }
```

Success response (`200`):
```json
{ "ticket_number": 42 }
```

Idempotent replay response (`200` — same `request_id` seen before):
```json
{ "ticket_number": 42, "idempotent": true }
```

Sold-out response (`409`):
```json
{ "error": "sold_out" }
```

### GET /status

Response:
```json
{
  "total": 100,
  "sold": 42,
  "tickets_issued": 42,
  "tickets": { "1": "alice", "2": "bob" },
  "users": { "alice": [1], "bob": [2] }
}
```

The corrected server also exposes two test-only fault-injection endpoints
used by `scripts/datastore-failure.sh` — see "Known Limitations" for why
these are not something a real production service would ship this way:

- `POST /admin/simulate-slow-db { "duration_ms": 10000 }`
- `POST /admin/simulate-db-down { "enabled": true }`

## Running Tests

```bash
scripts/run-tests.sh
# or: node --test tests/*.test.js
```

Actual output from this repo:

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The suite includes a 300-request/20-ticket concurrent stress test run
in-process (no network hop) and asserts ticket numbers land exactly on
`1..CAPACITY` with zero gaps or duplicates.

## Running Load Test

```bash
node load-test/load-test.js \
  --tickets 100 --concurrency 1000 --requests 20000 --duplicates 20 \
  --url http://localhost:3000
```

Flags: `--tickets`, `--concurrency`, `--requests`, `--duplicates` (percent),
`--url`, `--out` (optional file to save the report to).

## Invariant Verification

The load client verifies all four invariants **independently of what the
server claims** — from its own record of every response it received, plus
a final `GET /status`:

1. **Never sell more tickets than exist** — distinct ticket numbers
   observed, and the server's `sold` count, must both be ≤ capacity.
2. **Never issue the same ticket number twice** — a ticket number must
   never be associated with more than one distinct `request_id`.
3. **Same `request_id` never yields multiple tickets** — every
   `request_id` the client used must map to exactly one ticket number
   across all its (possibly concurrent) replays.
4. **`/status` count matches tickets actually issued** — `sold` must equal
   both the server's own `tickets_issued` and the client's independently
   observed distinct-ticket count.

## Naive Failure

**What was tested:** `scripts/break-naive.sh` — 100 tickets, 1000
concurrent buyers, 20,000 total requests, 20% of which deliberately
replay an in-flight `request_id` concurrently with fresh traffic.

**Why it failed:** the naive seller reads `sold` before an artificial
`await` (standing in for a real datastore round trip) and writes based on
that stale read afterward. Many requests read the same `sold` value before
any of them writes back.

**Actual result** (`results/naive-failure.txt`, one real run):

```
Total requests:        20000
Successful purchases:  3303 (2210 new tickets + 1093 idempotent replays)
Sold-out responses:    16697
Errors:                0
Requests/sec:          1661.0
Median latency:        496.59ms
P99 latency:           1604.99ms

Invariant 1 (never oversell): PASS  [distinct tickets observed=100, server sold=100, capacity=100]
Invariant 2 (unique ticket numbers): FAIL  [ticket numbers reused across different request_ids=100]
Invariant 3 (request_id idempotency): FAIL  [request_ids that got >1 distinct ticket=3]
Invariant 4 (status count matches issued tickets): PASS  [server sold=100, server tickets_issued=100, client observed distinct=100]

OVERALL: ONE OR MORE INVARIANTS FAILED
```

The striking number is **2210 "new ticket" responses collapsing onto only
100 distinct ticket numbers** — every one of the 100 slots was handed out
to roughly 22 different requests on average, all believing they'd won a
unique ticket. Invariant 1 and 4 happen to read PASS on this particular
run (races are non-deterministic — capacity-related invariants aren't
guaranteed to fail on every run the way the ticket-number and
idempotency races reliably do at this contention level), which is itself
evidence of why "it passed when I tried it" is not a correctness argument.

## Corrected Implementation

`src/server.js` wraps the read-check-write sequence in a single
`BEGIN IMMEDIATE ... COMMIT` SQLite transaction, checks/repairs
`request_id` idempotency inside that same transaction (not as a separate
pre-check), and derives `sold` from a live `COUNT(*)` rather than a
separately-maintained counter. See `DECISIONS.md` for the full mechanism
write-up (what race each piece prevents, how, and why it's actually atomic
rather than "thread-safe by convention").

## Performance Results

`scripts/benchmark.sh` — concurrency sweep, 2000-ticket capacity, 10,000
requests per level, 5% duplicate rate, against the corrected server.
Actual output (`results/benchmark.csv`):

| Concurrency | Requests/sec | Median latency | P99 latency |
|---:|---:|---:|---:|
| 10 | 1283.5 | 4.57ms | 34.43ms |
| 50 | 1352.4 | 28.96ms | 124.04ms |
| 100 | 1328.9 | 59.45ms | 209.11ms |
| 500 | 1261.4 | 314.59ms | 1061.47ms |
| 1000 | 1219.1 | 647.00ms | 2496.10ms |

**Bottleneck, from the measurements, not a guess:** throughput is flat at
~1250-1350 req/s across a 100x increase in concurrency (10 → 1000), while
median and P99 latency scale up roughly linearly with concurrency. That
signature — flat throughput, growing queueing latency — means the system
is bound by a single serialization point, not by client concurrency: every
`/buy` call takes SQLite's exclusive write lock (`BEGIN IMMEDIATE`) and the
whole transaction executes synchronously on Node's one thread, so only one
`/buy` can ever be "in flight" at a time regardless of how many clients are
waiting. Adding more concurrent clients just makes them queue longer; it
cannot add throughput. The fix for this specific bottleneck (if it were the
actual bottleneck in a production sale, which at this rps it usually isn't)
would be sharding the ticket pool across multiple SQLite files/processes,
not "more `await`" or a bigger connection pool — there's no connection pool
to grow.

## Datastore Failure Experiment

Real, captured evidence (`results/datastore-failure.txt`), via
`scripts/datastore-failure.sh` and its `/admin/simulate-*` test-only hooks.

**Slow datastore (one call takes 10s):** the triggering request's latency
was 10008ms — it really did block for the injected duration.

**Slow datastore blocks unrelated concurrent requests too, not just the
slow one** — this is the important finding: a second, completely unrelated
buyer arriving 100ms later was delayed almost as long as the slow request
itself (5908ms vs. 3008ms for a 3-second injected delay), because
`node:sqlite` is synchronous and blocks Node's single event-loop thread for
the full duration of the call.

**Datastore fully unavailable:** all 5 `/buy` calls during the simulated
outage returned a clean `503 datastore_unavailable` — no hangs, no
half-written state, no corrupted rows.

**After recovery:** the 5 retried requests (same `request_id`s used during
the outage) were each issued fresh tickets (5-9), and `GET /status` showed
`sold: 9` matching `tickets_issued: 9` exactly — no double-issuing, no
orphaned rows from the failed attempts.

**What happens to requests during an outage:** they fail fast with `503`,
not silently, and not with a misleading `500`.

**What happens to retries:** a retry with the same `request_id` after
recovery is treated as a *new* request, because the failed attempt never
got far enough to be recorded (the transaction rolled back before any
write). This is correct for this experiment but is a real limitation — see
below.

**What happens after recovery:** normal service resumes immediately; no
manual intervention was needed.

**Are confirmed purchases safe:** yes — nothing committed during the
outage (there was nothing to commit; the `BEGIN IMMEDIATE` transaction
rolls back cleanly before any write when the injected fault fires), and
the baseline ticket from before the outage (`ticket_number: 1`) was
untouched throughout.

**Limitations:** this is a single SQLite file on local disk, not a
networked datastore — a real Postgres/MySQL outage has additional failure
modes (connection pool exhaustion, partial commits visible to some
readers, replica lag) that this experiment cannot reproduce. The
"unavailable" and "slow" states are injected via an in-process flag, not
an actual crashed process, so this measures the server's *application-
level* handling of datastore errors, not disk/OS-level failure recovery.

## Advanced Constraint

**Not implemented.** Of the four options, none could be implemented and
*properly demonstrated with real evidence* in the time remaining without
either faking results or introducing untested risk into a repo that's
being submitted today:

- **A. Three instances behind a load balancer** — would require standing
  up a reverse proxy, verifying SQLite's file-locking actually serializes
  writes correctly across separate OS processes (the code's idempotency
  fallback path was written with this in mind, but is untested against
  real concurrent processes), and re-running the full load-test suite
  against the cluster. This is the most technically interesting option and
  the one I'd do first with more time.
- **B. Datastore crash/recovery** — largely covered by the degradation
  experiment above at the application level; a *real* process-kill/restart
  test would need supervised process management (e.g. a wrapper script
  that kills and respawns `node src/server.js` mid-load-test) that wasn't
  built.
- **C. Waitlist with 30-second reservation expiry** — changes `/buy`'s
  contract from "issue a ticket" to "issue a pending reservation," which
  is a real feature but would require a new `reserved`/`confirmed` state
  machine, an expiry sweep, and a full new set of invariant tests on top
  of the existing four — more surface area than could be tested properly
  in the remaining time.
- **D. Distributed load generator** — the current load client can already
  saturate a single server past its throughput ceiling (see Performance
  Results); a distributed generator only matters once the server itself
  is distributed (option A), so building it first would be solving the
  wrong problem.

I chose to spend the remaining time making the core evidence (naive
failure, corrected pass, benchmark, datastore failure) real and
reproducible instead. See `DECISIONS.md` "Two More Weeks" for what I'd
build next.

## Known Limitations

- **Single process, single SQLite file.** Correctness currently depends
  partly on Node's single-threaded synchronous execution, not purely on
  the database layer. The code is written so the SQLite-level guarantees
  (transactions + `UNIQUE` constraint) would also hold across multiple
  processes sharing the same file, but that claim is **untested** — see
  "Advanced Constraint" above.
- **A slow datastore call blocks the entire server**, not just the request
  that triggered it (measured above). There is no timeout, circuit
  breaker, or async off-loading of the SQLite call.
- **No authentication.** `/admin/simulate-*` endpoints are unauthenticated
  test hooks; they must never exist in anything resembling a production
  build. They exist only to make the datastore-failure experiment
  reproducible without a real second process to kill.
- **No horizontal scaling path implemented.** Sharding or replicating the
  ticket pool across multiple SQLite files/processes was identified as the
  fix for the measured throughput ceiling but not built.
- **Retries during an outage are not remembered as "in-flight."** If a
  request fails before its transaction starts (e.g. datastore genuinely
  down), the client's retry is indistinguishable from a first attempt from
  the server's point of view. This is correct (no double-issuing) but
  means a client that gave up on the failed request believing it "might
  have gone through" has no way to check other than retrying with the same
  `request_id`, which is exactly what the idempotency mechanism is for.
- **`node:sqlite` is an experimental Node API** (Node prints an
  `ExperimentalWarning` on startup). It is stable enough for this exercise
  but is not yet a long-term-support guarantee from the Node project.

## How to Reproduce

```bash
# 1. Tests
scripts/run-tests.sh

# 2. Naive failure
scripts/start-naive.sh &            # terminal 1
scripts/break-naive.sh              # terminal 2

# 3. Corrected pass (stop the naive server first, or use a different port)
scripts/start-server.sh &           # terminal 1
scripts/demo-fix.sh                 # terminal 2

# 4. Benchmark
scripts/benchmark.sh                # against the running corrected server

# 5. Datastore failure experiment
scripts/datastore-failure.sh        # against the running corrected server
```

All of the above complete in well under five minutes on a clean machine
with only Node.js 22.5+ installed — no `npm install`, no Docker, no
external services.

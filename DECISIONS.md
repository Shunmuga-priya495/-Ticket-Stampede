# Decisions

## Architecture Decision

Single Node.js process, built-in `http` module, `node:sqlite` for storage.
No framework, no ORM, no external database server. The whole job is three
routes and one correctness-critical write path — anything heavier is
surface area to test instead of ship. Node 22.5+ ships `node:sqlite`
(`DatabaseSync`) out of the box, so the stack needs **zero `npm install`**,
which matters for "runs on a clean machine in under five minutes."

## Alternatives Rejected

- **Postgres/Redis with a real client** — better production posture
  (multi-instance from day one), but needs a running service, a
  dependency, and pool tuning I don't have time to load-test today.
  `node:sqlite` gives real ACID transactions and a `UNIQUE` constraint
  without any of that setup cost.
- **Express** — added nothing over a few `if`-branches on
  `req.method`/`url.pathname`. Fewer dependencies to go wrong under load.
- **In-memory store + a mutex library for the "corrected" version** —
  would prove Node's single-threadedness, not that the *datastore layer*
  is safe, and wouldn't extend to a multi-instance setup at all.

## Concurrency Decision

`/buy`'s read-check-write sequence (has `request_id` already been
issued? is there capacity? issue the next number) runs inside one
`BEGIN IMMEDIATE ... COMMIT` transaction, executed synchronously —
`node:sqlite` has no async API, every call blocks until SQLite returns.
Two things combine to make this atomic:

1. **No `await` inside the transaction** — no other request's JS can run
   on the event loop until this one finishes. This removes exactly the
   race window the naive version has (its `await` mid-sequence *is* the bug).
2. **`BEGIN IMMEDIATE`** grabs SQLite's write lock at the start of the
   transaction, not lazily on first write — so even across multiple OS
   processes sharing one file, only one transaction can mutate ticket
   state at a time; SQLite serializes it independent of Node.

Ticket numbers are `COUNT(*) + 1` computed *inside* the same transaction
as the insert, so the number and the row can't drift apart between two
concurrent callers.

## Idempotency Decision

`request_id` is `UNIQUE` on the `tickets` table. The "have I seen this
before" check happens inside the same transaction as the insert, not as a
separate pre-check, so there's no gap between checking and recording. If
the `INSERT` itself throws a `UNIQUE constraint failed` (e.g. a second
process racing this one in a multi-instance deployment), the code catches
that specific error and returns the ticket that actually won instead of a
500 — the constraint is the real backstop, the pre-check is just an
optimization for the common case.

## Testing Decision

Broke the naive version on purpose with a real `await` (standing in for an
actual datastore round trip) between reading `sold` and writing it back,
and between checking and recording `request_id`. Then ran the real load
client against it: 100 tickets, 1000 concurrent buyers, 20,000 requests,
20% concurrent `request_id` replay. It failed for real — 2210 "new ticket"
responses collapsed onto 100 distinct ticket numbers, and 3 `request_id`s
got more than one ticket. I proved it the way a real incident would
surface it (client-observed duplicates under load), not by asserting on
internals.

## Performance Investigation

Benchmarked concurrency 10/50/100/500/1000 at 10,000 requests each.
Throughput stayed flat at ~1250-1350 req/s across the whole range while
median latency went 4.6ms → 647ms and P99 went 34ms → 2496ms. Flat
throughput plus linearly growing queueing latency is the signature of one
serialization point, not a client-scaling problem: every `/buy` holds
SQLite's exclusive write lock for its whole (synchronous) transaction, so
exactly one `/buy` runs system-wide at any instant. More clients just wait
longer; they can't add throughput. This is read off the actual numbers,
not guessed from the architecture — a CPU- or client-limited system would
show throughput rising then plateauing with concurrency, not staying flat
from concurrency 10.

## Failure Handling

Simulated (in-process flag, not a real process kill) a slow and a fully
unavailable datastore. Slow: the triggering call took 10.0s as injected;
more importantly, an unrelated request arriving 100ms later during a 3s
slow window was delayed almost as long (5.9s) — the synchronous SQLite
call blocks Node's one event-loop thread entirely, not just the request
that hit it. Unavailable: every `/buy` returned a clean `503`, nothing
hung. After recovery, a retry with the same `request_id` issued a correct,
non-duplicated ticket — no corrupted state, because the transaction never
got past `BEGIN IMMEDIATE` before the fault fired.

## Time Trade-offs

Not built: auth, a frontend, deployment infra, a connection pool (nothing
to pool — one synchronous file handle), and the advanced constraint
(documented as not implemented rather than faked — see README). Also
didn't build a real multi-process test, even though the `UNIQUE`-
constraint-catch fallback in `/buy` was written with that scenario in
mind — better to say "written for it, untested" than claim an unverified
guarantee.

## Advanced Constraint

Not implemented. Every option either needed infrastructure I couldn't also
load-test properly today (a load balancer, a supervised process-restart
harness) or would expand the invariant surface past what the existing
four-invariant suite covers (the waitlist option). Spending the remaining
time making naive-failure, corrected-pass, benchmark, and datastore-
failure evidence real and reproducible was worth more than a fifth feature
with no evidence behind it. Full option-by-option reasoning is in README.

## Known Limitations

Correctness currently leans partly on Node's single-threadedness, not
purely the database layer (untested across real multiple processes). A
slow datastore call blocks the *entire* server, not just the request that
hit it. Both are direct, measured consequences of the synchronous
`node:sqlite` API — see README for the full list.

## Two More Weeks

In order: (1) stand up 2-3 real instances of `src/server.js` against the
same file behind a reverse proxy and re-run the load-test suite against
the cluster, to see if the `UNIQUE`-constraint fallback actually holds
under real multi-process contention; (2) move SQLite calls behind an async
wrapper (e.g. a worker thread) so a slow datastore degrades only the
requests touching it, directly informed by the datastore-failure finding;
(3) if the serialization bottleneck matters at realistic scale, shard the
ticket pool across files by ticket-number range; (4) only then build the
waitlist/reservation feature, with its own invariant tests, rather than
bolt it onto a system not yet proven to scale past one process.

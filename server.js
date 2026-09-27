'use strict';

/**
 * CORRECTED SELLER.
 *
 * Datastore: SQLite via Node's built-in `node:sqlite` module (DatabaseSync).
 * No native compilation, no npm install, no network access needed — it
 * ships with Node 22.5+.
 *
 * How each invariant is actually enforced:
 *
 * Invariant 1 (never oversell) & Invariant 2 (unique ticket numbers):
 *   The read of the current ticket count, the total check, and the insert
 *   of the new ticket row all happen inside a single `BEGIN IMMEDIATE ...
 *   COMMIT` block, AND that block is executed synchronously (node:sqlite's
 *   DatabaseSync API has no async/await — every call blocks the calling
 *   thread until SQLite returns). Because Node is single-threaded and we
 *   never `await` in the middle of this block, no other request's JS can
 *   run until the block finishes. There is no window for two requests to
 *   interleave. `BEGIN IMMEDIATE` additionally grabs SQLite's write lock
 *   up front, which is what would keep this correct even if you ran
 *   multiple OS processes/instances against the same database file (see
 *   DECISIONS.md for the multi-instance discussion).
 *
 * Invariant 3 (request_id idempotency):
 *   `request_id` is a UNIQUE column. The idempotency check ("have I seen
 *   this request before?") happens inside the SAME atomic block as the
 *   insert, not as a separate pre-check — so there's no TOCTOU gap between
 *   checking and recording. As a second line of defense, if two concurrent
 *   processes somehow both attempt to insert the same request_id (multi
 *   instance case), the UNIQUE constraint itself rejects the second
 *   insert at the SQLite engine level; the code catches that and returns
 *   the ticket that was actually recorded.
 *
 * Invariant 4 (status count == tickets issued):
 *   `/status`'s `sold` count is a live `COUNT(*)` over the `tickets` table,
 *   not a separately-maintained counter that could drift out of sync with
 *   the actual rows.
 *
 * WHY this is "actually atomic" and not just "thread-safe by accident":
 *   SQLite guarantees that a transaction started with BEGIN IMMEDIATE holds
 *   the database write lock for its entire duration, and that all
 *   statements inside either all commit or all roll back together. Combined
 *   with the fact that node:sqlite's calls are synchronous (no interleaving
 *   possible within one process), the read-check-write sequence below is
 *   indivisible from the point of view of every other request.
 */

const http = require('http');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { readJsonBody, sendJson, makeRouter } = require('./http-helpers');

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sale (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    ticket_number INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
`);
// Ensure exactly one sale row exists.
db.exec(`INSERT OR IGNORE INTO sale (id, total) VALUES (1, 0);`);

// --- test-only fault injection knobs, used by scripts/datastore-failure.sh ---
// These exist purely to demonstrate/measure degraded-datastore behavior.
// They are not something a real production system would ship on an
// unauthenticated admin endpoint; see README "Known Limitations".
let SIMULATE_SLOW_MS = 0;
let SIMULATE_DOWN = false;

function maybeInjectFault() {
  if (SIMULATE_DOWN) {
    const err = new Error('datastore_unavailable');
    err.code = 'DATASTORE_DOWN';
    throw err;
  }
  if (SIMULATE_SLOW_MS > 0) {
    // Deliberately block synchronously to simulate a slow datastore call.
    // (A real slow DB call would block the same way from Node's point of
    // view, since node:sqlite is synchronous — this reproduces that.)
    const until = Date.now() + SIMULATE_SLOW_MS;
    while (Date.now() < until) {
      /* busy-wait: intentional, see README for why */
    }
  }
}

function resetSale(total) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM tickets').run();
    db.prepare('UPDATE sale SET total = ? WHERE id = 1').run(total);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getStatus() {
  const { total } = db.prepare('SELECT total FROM sale WHERE id = 1').get();
  const { sold } = db.prepare('SELECT COUNT(*) AS sold FROM tickets').get();
  const rows = db.prepare('SELECT ticket_number, user_id FROM tickets ORDER BY ticket_number').all();
  const tickets = {};
  const users = {};
  for (const row of rows) {
    tickets[row.ticket_number] = row.user_id;
    (users[row.user_id] = users[row.user_id] || []).push(row.ticket_number);
  }
  return { total, sold, tickets_issued: rows.length, tickets, users };
}

function buy(user_id, request_id) {
  // Fault injection lives INSIDE the try block on purpose: a real datastore
  // failure would happen on the first query we send it (e.g. the SELECT
  // below), i.e. after we've already opened the transaction. If we check
  // this before BEGIN IMMEDIATE, we never exercise the rollback path and
  // we'd be testing a scenario that can't happen with a real datastore.
  db.exec('BEGIN IMMEDIATE');
  try {
    maybeInjectFault();

    const existing = db.prepare('SELECT ticket_number FROM tickets WHERE request_id = ?').get(request_id);
    if (existing) {
      db.exec('COMMIT');
      return { status: 200, body: { ticket_number: existing.ticket_number, idempotent: true } };
    }

    const { total } = db.prepare('SELECT total FROM sale WHERE id = 1').get();
    const { sold } = db.prepare('SELECT COUNT(*) AS sold FROM tickets').get();

    if (sold >= total) {
      db.exec('COMMIT'); // no writes happened; COMMIT is a no-op but keeps the tx balanced
      return { status: 409, body: { error: 'sold_out' } };
    }

    const ticketNumber = sold + 1;
    try {
      db.prepare(
        'INSERT INTO tickets (ticket_number, user_id, request_id, created_at) VALUES (?, ?, ?, ?)'
      ).run(ticketNumber, user_id, request_id, Date.now());
    } catch (insertErr) {
      // Belt-and-suspenders: if some other writer (e.g. a second process in
      // the multi-instance setup) already used request_id between our
      // SELECT and our INSERT, the UNIQUE constraint fires here. Recover by
      // returning the row that actually won, instead of erroring out.
      if (String(insertErr.message).includes('UNIQUE constraint failed')) {
        const winner = db.prepare('SELECT ticket_number FROM tickets WHERE request_id = ?').get(request_id);
        db.exec('COMMIT');
        return { status: 200, body: { ticket_number: winner.ticket_number, idempotent: true } };
      }
      throw insertErr;
    }

    db.exec('COMMIT');
    return { status: 200, body: { ticket_number: ticketNumber } };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      /* if COMMIT already happened, ROLLBACK has nothing to do */
    }
    if (e.code === 'DATASTORE_DOWN') {
      return { status: 503, body: { error: 'datastore_unavailable' } };
    }
    throw e;
  }
}

const router = makeRouter({
  POST: {
    '/reset': async (req, res) => {
      const body = await readJsonBody(req);
      const total = Number(body.tickets ?? body.total);
      if (!Number.isInteger(total) || total < 0) {
        return sendJson(res, 400, { error: 'tickets must be a non-negative integer' });
      }
      resetSale(total);
      sendJson(res, 200, { ok: true, total });
    },
    '/buy': async (req, res) => {
      const body = await readJsonBody(req);
      const { user_id, request_id } = body;
      if (!user_id || !request_id) {
        return sendJson(res, 400, { error: 'user_id and request_id are required' });
      }
      const result = buy(user_id, request_id);
      sendJson(res, result.status, result.body);
    },
    // --- test-only endpoints for the datastore-failure experiment ---
    '/admin/simulate-slow-db': async (req, res) => {
      const body = await readJsonBody(req);
      SIMULATE_SLOW_MS = Number(body.duration_ms) || 0;
      sendJson(res, 200, { ok: true, simulate_slow_ms: SIMULATE_SLOW_MS });
    },
    '/admin/simulate-db-down': async (req, res) => {
      const body = await readJsonBody(req);
      SIMULATE_DOWN = Boolean(body.enabled);
      sendJson(res, 200, { ok: true, simulate_down: SIMULATE_DOWN });
    },
  },
  GET: {
    '/status': async (req, res) => {
      sendJson(res, 200, getStatus());
    },
  },
});

if (require.main === module) {
  const server = http.createServer(router);
  server.listen(PORT, () => {
    console.log(`[server] corrected implementation listening on http://localhost:${PORT}`);
    console.log(`[server] sqlite db: ${DB_PATH}`);
  });
}

module.exports = { router, resetSale, getStatus, buy, db };

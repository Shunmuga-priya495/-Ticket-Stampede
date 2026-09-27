'use strict';

/**
 * NAIVE SELLER — intentionally unsafe. Do not copy this pattern.
 *
 * This implementation uses a plain in-memory JS object as the "datastore"
 * and does the classic check-then-act sequence:
 *
 *   1. read current `sold` count
 *   2. decide whether there's a ticket left
 *   3. (simulate a real datastore round trip with an await)
 *   4. write the new `sold` count / issue the ticket
 *
 * Step 3 is not a contrived trick — it stands in for the network hop you'd
 * have in any real system (a query to Postgres, a call to Redis, etc).
 * Because step 1's read and step 4's write are NOT combined into one
 * atomic operation, any two requests that land in the same window between
 * "read" and "write" both act on the same stale value.
 *
 * Concretely this breaks all four invariants:
 *   - Invariant 1 (never oversell): many concurrent requests can each
 *     independently observe `sold < total` before any of them writes back,
 *     so more tickets get issued than exist.
 *   - Invariant 2 (unique ticket numbers): two requests that read the same
 *     `sold` value compute the same `ticketNumber = sold + 1`.
 *   - Invariant 3 (request_id idempotency): the "have we seen this
 *     request_id" check and the "record this request_id" write are also
 *     split across the same await, so a request_id replayed concurrently
 *     (not sequentially) can be issued two different tickets.
 *   - Invariant 4 (status count matches issued tickets): lost updates on
 *     `state.sold` mean the counter can end up lower than the number of
 *     ticket rows actually created.
 *
 * There is no lock, no transaction, and no atomic compare-and-swap here.
 * That's the point.
 */

const http = require('http');
const { readJsonBody, sendJson, makeRouter } = require('./http-helpers');

const PORT = process.env.PORT || 3000;

let state = null;

function resetState(total) {
  state = {
    total,
    sold: 0,
    tickets: {}, // ticket_number -> user_id
    seenRequests: new Map(), // request_id -> ticket_number
  };
}

// start with a default so /status and /buy don't crash before /reset is called
resetState(0);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleBuy(user_id, request_id) {
  // --- naive idempotency check (races with the write at the bottom) ---
  if (state.seenRequests.has(request_id)) {
    return { status: 200, body: { ticket_number: state.seenRequests.get(request_id), idempotent: true } };
  }

  // --- naive capacity check (reads a value that may go stale) ---
  const soldAtCheckTime = state.sold;
  if (soldAtCheckTime >= state.total) {
    return { status: 409, body: { error: 'sold_out' } };
  }

  // Simulate a real datastore round trip (e.g. an async query). This is
  // the yield point that opens the race window: other requests' JS callbacks
  // can run on the event loop while this one is "waiting on the datastore".
  await sleep(Math.random() * 15);

  // BUG (intentional): we use the value we read *before* the await, not a
  // fresh read. Two requests that both read soldAtCheckTime=41 will both
  // compute ticketNumber=42, and will both write state.sold = 42 (a lost
  // update instead of two increments).
  const ticketNumber = soldAtCheckTime + 1;
  state.sold = soldAtCheckTime + 1;
  state.tickets[ticketNumber] = user_id;
  state.seenRequests.set(request_id, ticketNumber);

  return { status: 200, body: { ticket_number: ticketNumber } };
}

const router = makeRouter({
  POST: {
    '/reset': async (req, res) => {
      const body = await readJsonBody(req);
      const total = Number(body.tickets ?? body.total);
      if (!Number.isInteger(total) || total < 0) {
        return sendJson(res, 400, { error: 'tickets must be a non-negative integer' });
      }
      resetState(total);
      sendJson(res, 200, { ok: true, total });
    },
    '/buy': async (req, res) => {
      const body = await readJsonBody(req);
      const { user_id, request_id } = body;
      if (!user_id || !request_id) {
        return sendJson(res, 400, { error: 'user_id and request_id are required' });
      }
      const result = await handleBuy(user_id, request_id);
      sendJson(res, result.status, result.body);
    },
  },
  GET: {
    '/status': async (req, res) => {
      const users = {};
      for (const [ticketNumber, userId] of Object.entries(state.tickets)) {
        (users[userId] = users[userId] || []).push(Number(ticketNumber));
      }
      sendJson(res, 200, {
        total: state.total,
        sold: state.sold,
        tickets_issued: Object.keys(state.tickets).length,
        tickets: state.tickets, // ticket_number -> user_id
        users, // user_id -> [ticket_number, ...]
      });
    },
  },
});

if (require.main === module) {
  const server = http.createServer(router);
  server.listen(PORT, () => {
    console.log(`[naive-server] listening on http://localhost:${PORT}`);
    console.log('[naive-server] WARNING: this implementation is intentionally unsafe under concurrency.');
  });
}

module.exports = { router, resetState, getState: () => state };

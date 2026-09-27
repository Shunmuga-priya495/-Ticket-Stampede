'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// Use a throwaway DB file per test run so tests don't collide with a
// dev server you might have running on the default data.sqlite.
const TEST_DB = path.join(__dirname, `.test-${process.pid}.sqlite`);
process.env.DB_PATH = TEST_DB;
process.env.PORT = 0;

const { router, resetSale, getStatus } = require('../src/server');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(router);
    server.listen(0, () => resolve(server));
  });
}

async function buy(baseUrl, user_id, request_id) {
  const res = await fetch(`${baseUrl}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, request_id }),
  });
  return { status: res.status, body: await res.json() };
}

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch (_) { /* ignore */ }
  }
});

test('reset clears state and sets capacity', async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  try {
    resetSale(5);
    const status = getStatus();
    assert.equal(status.total, 5);
    assert.equal(status.sold, 0);
    assert.equal(Object.keys(status.tickets).length, 0);
  } finally {
    server.close();
  }
});

test('a single buy issues ticket 1 and status reflects it', async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  try {
    resetSale(3);
    const res = await buy(baseUrl, 'alice', 'r1');
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket_number, 1);

    const status = getStatus();
    assert.equal(status.sold, 1);
    assert.equal(status.tickets['1'], 'alice');
  } finally {
    server.close();
  }
});

test('invariant 3: same request_id replayed sequentially returns the same ticket', async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  try {
    resetSale(5);
    const first = await buy(baseUrl, 'alice', 'dup-req');
    const second = await buy(baseUrl, 'alice', 'dup-req');
    const third = await buy(baseUrl, 'alice', 'dup-req');
    assert.equal(first.body.ticket_number, second.body.ticket_number);
    assert.equal(second.body.ticket_number, third.body.ticket_number);

    const status = getStatus();
    assert.equal(status.sold, 1, 'only one ticket should have been issued for the repeated request_id');
  } finally {
    server.close();
  }
});

test('invariant 1 & 2: high-contention concurrent buys never oversell or duplicate ticket numbers', async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  try {
    const CAPACITY = 20;
    const ATTEMPTS = 300; // 15x more buyers than tickets
    resetSale(CAPACITY);

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) => buy(baseUrl, `user-${i}`, `req-${i}`))
    );

    const successes = results.filter((r) => r.status === 200);
    const soldOuts = results.filter((r) => r.status === 409);

    assert.equal(successes.length + soldOuts.length, ATTEMPTS, 'every request should be a success or a clean sold-out');
    assert.equal(successes.length, CAPACITY, 'exactly CAPACITY requests should succeed, no more, no less');

    const ticketNumbers = successes.map((r) => r.body.ticket_number);
    const distinct = new Set(ticketNumbers);
    assert.equal(distinct.size, ticketNumbers.length, 'no ticket number should be issued twice');
    assert.deepEqual(
      [...distinct].sort((a, b) => a - b),
      Array.from({ length: CAPACITY }, (_, i) => i + 1),
      'ticket numbers should be exactly 1..CAPACITY with no gaps or duplicates'
    );

    const status = getStatus();
    assert.equal(status.sold, CAPACITY, 'invariant 4: status count must equal tickets actually issued');
    assert.equal(status.tickets_issued, CAPACITY);
  } finally {
    server.close();
  }
});

test('invariant 3 under concurrency: the same request_id fired concurrently many times yields exactly one ticket', async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  try {
    resetSale(10);
    const CONCURRENT_REPLAYS = 50;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REPLAYS }, () => buy(baseUrl, 'bob', 'replayed-request'))
    );
    const ticketNumbers = new Set(results.map((r) => r.body.ticket_number));
    assert.equal(ticketNumbers.size, 1, 'all concurrent replays of the same request_id must resolve to one ticket');

    const status = getStatus();
    assert.equal(status.sold, 1, 'only one ticket should exist despite 50 concurrent replays');
  } finally {
    server.close();
  }
});

test('sold-out responses are clean once capacity is exhausted', async () => {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  try {
    resetSale(1);
    const first = await buy(baseUrl, 'a', 'r1');
    const second = await buy(baseUrl, 'b', 'r2');
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'sold_out');
  } finally {
    server.close();
  }
});

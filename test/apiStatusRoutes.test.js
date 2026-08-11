import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createApiStatusRouter } from '../src/http/apiStatusRoutes.js';

async function withServer(router, run) {
  const app = express();
  app.use('/api', router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('GET /api/status returns a no-store JSON snapshot', async () => {
  const snapshot = {
    schemaVersion: 1,
    checkedAt: '2026-08-11T12:00:00.000Z',
    services: [],
    summary: { overall: 'operational' },
  };
  const router = createApiStatusRouter({
    monitor: { getSnapshot: async () => snapshot },
  });

  await withServer(router, async (origin) => {
    const response = await fetch(`${origin}/api/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.deepEqual(await response.json(), snapshot);
  });
});

test('GET /api/status returns a safe retryable 503 when snapshot generation fails', async () => {
  const logged = [];
  const router = createApiStatusRouter({
    monitor: { getSnapshot: async () => { throw new Error('sensitive upstream details'); } },
    logger: { error: (...args) => logged.push(args) },
    now: () => new Date('2026-08-11T12:00:00.000Z'),
  });

  await withServer(router, async (origin) => {
    const response = await fetch(`${origin}/api/status`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '10');
    assert.deepEqual(body, {
      error: {
        code: 'STATUS_CHECK_FAILED',
        message: 'Live status is temporarily unavailable.',
      },
      checkedAt: '2026-08-11T12:00:00.000Z',
      retryAfterMs: 10_000,
    });
    assert.doesNotMatch(JSON.stringify(body), /sensitive upstream details/);
    assert.equal(logged.length, 1);
  });
});

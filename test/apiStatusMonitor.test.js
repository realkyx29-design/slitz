import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVICE_STATE,
  checkBotApi,
  createApiStatusMonitor,
  timedFetch,
} from '../src/services/apiStatusMonitor.js';

function response(body = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readyClient({ ping = 25, database = { isDegraded: false, connectionType: 'postgres' } } = {}) {
  return {
    isReady: () => true,
    ws: { ping },
    db: { getStatus: () => database },
  };
}

function successfulFetch(url) {
  if (url.includes('status')) {
    return Promise.resolve(response({ status: { indicator: 'none', description: 'All Systems Operational' } }));
  }
  return Promise.resolve(response({ ok: true }));
}

test('returns Bot, Discord, and GitHub as working with response times', async () => {
  const monitor = createApiStatusMonitor(readyClient(), {
    fetchImpl: successfulFetch,
    cacheMs: 0,
    nowDate: () => new Date('2026-08-11T12:00:00.000Z'),
  });

  const snapshot = await monitor.getSnapshot();

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.checkedAt, '2026-08-11T12:00:00.000Z');
  assert.deepEqual(snapshot.services.map(({ id, name, state }) => ({ id, name, state })), [
    { id: 'bot', name: 'Bot API', state: SERVICE_STATE.WORKING },
    { id: 'discord', name: 'Discord API', state: SERVICE_STATE.WORKING },
    { id: 'github', name: 'GitHub API', state: SERVICE_STATE.WORKING },
  ]);
  assert.equal(snapshot.services[0].pingMs, 25);
  assert.ok(snapshot.services.slice(1).every((service) => Number.isInteger(service.pingMs)));
  assert.deepEqual(snapshot.summary, {
    overall: 'operational',
    total: 3,
    working: 3,
    degraded: 0,
    offline: 0,
  });
});

test('marks a reachable API as degraded when its provider reports an incident', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('githubstatus.com')) {
      return response({ status: { indicator: 'minor', description: 'Degraded API requests' } });
    }
    if (url.includes('discordstatus.com')) {
      return response({ status: { indicator: 'none', description: 'All Systems Operational' } });
    }
    return response({ ok: true });
  };

  const snapshot = await createApiStatusMonitor(readyClient(), { fetchImpl, cacheMs: 0 }).getSnapshot();
  const github = snapshot.services.find((service) => service.id === 'github');

  assert.equal(github.state, SERVICE_STATE.DEGRADED);
  assert.equal(github.indicator, '🚦');
  assert.equal(github.message, 'Degraded API requests');
  assert.equal(github.reason, 'provider_incident');
  assert.equal(snapshot.summary.overall, 'degraded');
});

test('classifies rate limiting as degraded instead of offline', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.github.com/meta') return response({ message: 'rate limited' }, 429);
    if (url.includes('status')) return response({ status: { indicator: 'none' } });
    return response({ ok: true });
  };

  const snapshot = await createApiStatusMonitor(readyClient(), { fetchImpl, cacheMs: 0 }).getSnapshot();
  const github = snapshot.services.find((service) => service.id === 'github');

  assert.equal(github.state, SERVICE_STATE.DEGRADED);
  assert.equal(github.reason, 'rate_limited');
  assert.equal(github.httpStatus, 429);
  assert.ok(Number.isInteger(github.pingMs));
});

test('isolates a failed provider and keeps a complete snapshot', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://discord.com/api/v10/gateway') throw Object.assign(new Error('socket failed'), { code: 'ECONNRESET' });
    if (url.includes('status')) return response({ status: { indicator: 'none' } });
    return response({ ok: true });
  };

  const snapshot = await createApiStatusMonitor(readyClient(), { fetchImpl, cacheMs: 0 }).getSnapshot();
  const discord = snapshot.services.find((service) => service.id === 'discord');
  const github = snapshot.services.find((service) => service.id === 'github');

  assert.equal(snapshot.services.length, 3);
  assert.equal(discord.state, SERVICE_STATE.OFFLINE);
  assert.equal(discord.indicator, '❌');
  assert.equal(discord.pingMs, null);
  assert.equal(github.state, SERVICE_STATE.WORKING);
  assert.equal(snapshot.summary.overall, 'outage');
});

test('marks HTTP server errors offline without treating a failed status feed as an API outage', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.github.com/meta') return response({ message: 'unavailable' }, 503);
    if (url.includes('status.com')) throw new Error('status feed unavailable');
    return response({ ok: true });
  };

  const snapshot = await createApiStatusMonitor(readyClient(), { fetchImpl, cacheMs: 0 }).getSnapshot();
  const discord = snapshot.services.find((service) => service.id === 'discord');
  const github = snapshot.services.find((service) => service.id === 'github');

  assert.equal(discord.state, SERVICE_STATE.WORKING);
  assert.equal(github.state, SERVICE_STATE.OFFLINE);
  assert.equal(github.reason, 'server_error');
  assert.equal(github.httpStatus, 503);
  assert.ok(Number.isInteger(github.pingMs));
});

test('aborts a request that exceeds its timeout', async () => {
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });

  const result = await timedFetch('https://example.test', {
    fetchImpl: hangingFetch,
    timeoutMs: 10,
  });

  assert.equal(result.kind, 'timeout');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.pingMs, null);
});

test('Bot API reports offline, degraded database, high ping, and healthy states correctly', () => {
  const offline = checkBotApi({ isReady: () => false });
  assert.equal(offline.state, SERVICE_STATE.OFFLINE);
  assert.equal(offline.reason, 'bot_not_ready');

  const databaseDegraded = checkBotApi(readyClient({
    database: { isDegraded: true, degradedReason: 'PostgreSQL unavailable' },
  }));
  assert.equal(databaseDegraded.state, SERVICE_STATE.DEGRADED);
  assert.equal(databaseDegraded.reason, 'database_degraded');

  const highPing = checkBotApi(readyClient({ ping: 900 }), { degradedPingMs: 750 });
  assert.equal(highPing.state, SERVICE_STATE.DEGRADED);
  assert.equal(highPing.reason, 'high_latency');

  const healthy = checkBotApi(readyClient({ ping: 42 }));
  assert.equal(healthy.state, SERVICE_STATE.WORKING);
  assert.equal(healthy.indicator, '✅');
  assert.equal(healthy.pingMs, 42);
});

test('deduplicates concurrent checks and serves the short-lived cache', async () => {
  let requestCount = 0;
  const fetchImpl = async (url) => {
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return url.includes('status')
      ? response({ status: { indicator: 'none' } })
      : response({ ok: true });
  };

  let now = 1_000;
  const monitor = createApiStatusMonitor(readyClient(), {
    fetchImpl,
    cacheMs: 10_000,
    nowMs: () => now,
  });

  const [first, second] = await Promise.all([monitor.getSnapshot(), monitor.getSnapshot()]);
  assert.strictEqual(first, second);
  assert.equal(requestCount, 4);

  const cached = await monitor.getSnapshot();
  assert.strictEqual(cached, first);
  assert.equal(requestCount, 4);

  now += 10_001;
  const refreshed = await monitor.getSnapshot();
  assert.notStrictEqual(refreshed, first);
  assert.equal(requestCount, 8);
});

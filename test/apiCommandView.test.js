import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const { buildStatusPayload, buildUnavailablePayload } = await import('../src/commands/Core/api.js');

const snapshot = {
  checkedAt: '2026-08-11T12:00:00.000Z',
  summary: { overall: 'degraded' },
  services: [
    { name: 'Bot API', state: 'working', indicator: '✅', label: 'Working normally', message: 'Working normally.', pingMs: 25 },
    { name: 'Discord API', state: 'working', indicator: '✅', label: 'Working normally', message: 'Working normally.', pingMs: 42 },
    { name: 'GitHub API', state: 'degraded', indicator: '🚦', label: 'Issues detected', message: 'Issues detected.', pingMs: null },
  ],
};

test('Discord API status view uses the requested indicators, services, pings, and banner', () => {
  const payload = buildStatusPayload(snapshot);

  assert.match(payload.content, /✅ \*\*Bot API\*\* — Ping: \*\*25ms\*\*/);
  assert.match(payload.content, /✅ \*\*Discord API\*\* — Ping: \*\*42ms\*\*/);
  assert.match(payload.content, /🚦 \*\*GitHub API\*\* — Issues detected/);
  assert.doesNotMatch(payload.content, /REAL STATUS/i);
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, 'slitz-status-banner.png');
  assert.equal(payload.embeds[0].data.image.url, 'attachment://slitz-status-banner.png');
  assert.equal(payload.components.length, 1);
});

test('Discord fallback does not incorrectly mark individual APIs offline', () => {
  const payload = buildUnavailablePayload();

  assert.match(payload.content, /Live status is temporarily unavailable/);
  assert.match(payload.content, /No individual service has been marked offline/);
  assert.doesNotMatch(payload.content, /❌/);
});

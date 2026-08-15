import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    ALERT_LIMITS,
    addAlert,
    checkAlerts,
    getAlertCount,
    getAlertsForUser,
    removeAlerts,
    stopAllAlerts,
    __testables,
} = await import('../src/services/trading/tradeAlerts.js');

const { clearMarketCaches } = await import('../src/services/trading/marketDataService.js');

const USER = '111111111111111111';
const CHANNEL = 'c1';

/** Stub fetch so BONK quotes at a controlled price. */
function stubPrice(price) {
    const original = globalThis.fetch;

    globalThis.fetch = async (url) => {
        const href = String(url);

        if (href.includes('/coins/markets')) {
            return {
                ok: true,
                status: 200,
                json: async () => ([{
                    id: 'bonk',
                    symbol: 'bonk',
                    name: 'Bonk',
                    current_price: price,
                    market_cap: 210_000_000,
                    total_volume: 45_000_000,
                    price_change_percentage_24h_in_currency: 4,
                    last_updated: new Date().toISOString(),
                }]),
            };
        }

        return { ok: false, status: 404, json: async () => ({}) };
    };

    return () => { globalThis.fetch = original; };
}

function fakeClient() {
    const sent = [];
    return {
        sent,
        channels: {
            fetch: async () => ({
                send: async (payload) => { sent.push(payload); return { id: 'm1' }; },
            }),
        },
    };
}

const baseAlert = (overrides = {}) => ({
    userId: USER,
    channelId: CHANNEL,
    guildId: 'g1',
    query: 'BONK',
    symbol: 'BONK',
    targetPrice: 0.000025,
    direction: 'above',
    basePrice: 0.00002,
    ...overrides,
});

test.beforeEach(async () => {
    await stopAllAlerts('test-reset');
    clearMarketCaches();
});

test('addAlert validates its inputs', () => {
    assert.equal(addAlert(baseAlert()).ok, true);
    assert.equal(addAlert(baseAlert({ targetPrice: null })).ok, false);
    assert.equal(addAlert(baseAlert({ direction: 'sideways' })).ok, false);
    assert.equal(addAlert(baseAlert({ channelId: null })).ok, false);
});

test('re-adding the same coin+direction replaces the target', () => {
    const first = addAlert(baseAlert());
    const second = addAlert(baseAlert({ targetPrice: 0.00005 }));

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.replaced, true);
    assert.equal(getAlertsForUser(USER).length, 1);
    assert.equal(second.alert.targetPrice, 0.00005);
});

test('per-user alert cap is enforced', () => {
    for (let i = 0; i < ALERT_LIMITS.MAX_PER_USER; i += 1) {
        const result = addAlert(baseAlert({ query: `COIN${i}`, direction: i % 2 ? 'below' : 'above' }));
        assert.equal(result.ok, true);
    }

    const overflow = addAlert(baseAlert({ query: 'ONE_MORE' }));
    assert.equal(overflow.ok, false);
    assert.match(overflow.reason, /remove one/i);
});

test('removeAlerts clears every direction for a coin', () => {
    addAlert(baseAlert({ direction: 'above' }));
    addAlert(baseAlert({ direction: 'below', targetPrice: 0.00001 }));

    const result = removeAlerts(USER, 'bonk');

    assert.equal(result.ok, true);
    assert.equal(result.removed, 2);
    assert.equal(getAlertCount(), 0);
    assert.equal(removeAlerts(USER, 'nope').ok, false);
});

test('an above alert fires once the price crosses the target', async () => {
    addAlert(baseAlert({ targetPrice: 0.000025 }));

    const restore = stubPrice(0.000026);
    const client = fakeClient();

    try {
        const fired = await checkAlerts({ client });

        assert.equal(fired.length, 1);
        assert.equal(fired[0].alert.symbol, 'BONK');
        assert.equal(getAlertCount(), 0, 'alerts are single-shot');

        assert.equal(client.sent.length, 1);
        const payload = client.sent[0];
        assert.ok(payload.content.includes(`<@${USER}>`), 'owner is pinged');
        assert.deepEqual(payload.allowedMentions, { users: [USER], parse: [] });
        assert.ok(!payload.content.includes('@everyone'));
    } finally {
        restore();
    }
});

test('a below alert fires when the price drops to the target', async () => {
    addAlert(baseAlert({ direction: 'below', targetPrice: 0.000015 }));

    const restore = stubPrice(0.000014);
    const client = fakeClient();

    try {
        const fired = await checkAlerts({ client });
        assert.equal(fired.length, 1);
        assert.equal(getAlertCount(), 0);
    } finally {
        restore();
    }
});

test('alerts stay armed while the price has not reached the target', async () => {
    addAlert(baseAlert({ targetPrice: 0.00005 }));

    const restore = stubPrice(0.00002);
    const client = fakeClient();

    try {
        const fired = await checkAlerts({ client });
        assert.equal(fired.length, 0);
        assert.equal(getAlertCount(), 1);
        assert.equal(client.sent.length, 0);
    } finally {
        restore();
    }
});

test('unresolvable coins retire the alert after repeated failures', async () => {
    // Stub a fetch that always 404s.
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

    addAlert(baseAlert());

    try {
        for (let i = 0; i < ALERT_LIMITS.MAX_CONSECUTIVE_ERRORS; i += 1) {
            await checkAlerts({ client: fakeClient() });
        }

        assert.equal(getAlertCount(), 0, 'dead tickers must not spin forever');
    } finally {
        globalThis.fetch = original;
    }
});

test('isHit applies a small tolerance band around the target', () => {
    const { isHit } = __testables;
    const alert = { targetPrice: 1, direction: 'above' };

    assert.equal(isHit(alert, 1), true);
    assert.equal(isHit(alert, 0.9996), true, 'within tolerance');
    assert.equal(isHit(alert, 0.99), false);

    const below = { targetPrice: 1, direction: 'below' };
    assert.equal(isHit(below, 1.0004), true, 'within tolerance');
    assert.equal(isHit(below, 1.01), false);
});

test('stopAllAlerts clears everything for shutdown', async () => {
    addAlert(baseAlert());
    addAlert(baseAlert({ query: 'WIF', symbol: 'WIF', direction: 'below', targetPrice: 1 }));

    const cleared = await stopAllAlerts('test');

    assert.equal(cleared, 2);
    assert.equal(getAlertCount(), 0);
});

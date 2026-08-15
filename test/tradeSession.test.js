import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    SESSION_LIMITS,
    clampDuration,
    clampInterval,
    createSession,
    getActiveSessionCount,
    getSession,
    renderSession,
    shouldPing,
    stopAllSessions,
    stopSession,
} = await import('../src/services/trading/tradeSessionManager.js');

const NOTIFY_ID = '1377402826514235442';

const quote = (price = 75.11, change24h = -1.4) => ({
    id: 'solana',
    name: 'Solana',
    symbol: 'SOL',
    source: 'coingecko',
    price,
    change1h: 0.1,
    change24h,
    change7d: 1.8,
    high24h: 77.36,
    low24h: 73.59,
    marketCap: 43.77e9,
    volume24h: 1.08e9,
    rank: 5,
    ath: 259.96,
    athChangePercent: -71.1,
    sparkline: Array.from({ length: 168 }, (_, i) => 73 + i * 0.01),
    chain: null,
    lastUpdated: Date.now(),
});

/** Minimal stand-in for a discord.js Message. */
function fakeMessage() {
    const edits = [];
    return {
        edits,
        async edit(payload) {
            edits.push(payload);
            return this;
        },
    };
}

test.afterEach(async () => {
    await stopAllSessions('test-cleanup');
});

test('interval and duration are clamped into a safe range', () => {
    assert.equal(clampInterval(30), 30_000);
    assert.equal(clampInterval(1), SESSION_LIMITS.MIN_INTERVAL_MS);
    assert.equal(clampInterval(99_999), SESSION_LIMITS.MAX_INTERVAL_MS);
    assert.equal(clampInterval(null), SESSION_LIMITS.DEFAULT_INTERVAL_MS);

    assert.equal(clampDuration(15), 15 * 60_000);
    assert.equal(clampDuration(9999), SESSION_LIMITS.MAX_DURATION_MS);
    assert.equal(clampDuration(null), SESSION_LIMITS.DEFAULT_DURATION_MS);
});

test('a session registers, then stops and deregisters cleanly', async () => {
    const before = getActiveSessionCount();

    const created = createSession({
        message: fakeMessage(),
        query: 'SOL',
        quote: quote(),
        guildId: 'g1',
        channelId: 'c1',
        userId: 'u1',
        notifyUserId: NOTIFY_ID,
        intervalMs: 15_000,
        durationMs: 300_000,
    });

    assert.equal(created.ok, true);
    assert.equal(getActiveSessionCount(), before + 1);
    assert.equal(created.session.maxUpdates, 20);
    assert.ok(getSession(created.session.id));

    await stopSession(created.session.id);

    assert.equal(getSession(created.session.id), null);
    assert.equal(getActiveSessionCount(), before);
});

test('the per-guild session cap is enforced', () => {
    const made = [];

    for (let i = 0; i < SESSION_LIMITS.MAX_SESSIONS_PER_GUILD; i += 1) {
        const r = createSession({
            message: fakeMessage(),
            query: `C${i}`,
            quote: quote(),
            guildId: 'capped',
            userId: 'u1',
            notifyUserId: NOTIFY_ID,
        });
        assert.equal(r.ok, true);
        made.push(r);
    }

    const overflow = createSession({
        message: fakeMessage(),
        query: 'ONE_TOO_MANY',
        quote: quote(),
        guildId: 'capped',
        userId: 'u1',
        notifyUserId: NOTIFY_ID,
    });

    assert.equal(overflow.ok, false);
    assert.match(overflow.reason, /live trackers/i);
});

test('stopAllSessions clears every timer for shutdown', async () => {
    for (let i = 0; i < 3; i += 1) {
        createSession({
            message: fakeMessage(),
            query: `X${i}`,
            quote: quote(),
            guildId: `g${i}`,
            userId: 'u1',
            notifyUserId: NOTIFY_ID,
        });
    }

    assert.ok(getActiveSessionCount() >= 3);
    await stopAllSessions('shutdown');
    assert.equal(getActiveSessionCount(), 0);
});

test('the ping fires on first render, then only on a meaningful move', () => {
    const base = {
        notifyUserId: NOTIFY_ID,
        lastPingAt: null,
        lastPingPrice: null,
    };

    // First render always pings.
    assert.equal(shouldPing(base, quote(100)), true);

    const now = Date.now();
    const settled = {
        notifyUserId: NOTIFY_ID,
        lastPingAt: now - 5 * 60_000,
        lastPingPrice: 100,
    };

    // Below the threshold: stay quiet.
    assert.equal(shouldPing(settled, quote(100.2), { now }), false);
    // A real move in either direction re-pings.
    assert.equal(shouldPing(settled, quote(102), { now }), true);
    assert.equal(shouldPing(settled, quote(98), { now }), true);

    // Big move but too soon after the last ping: still quiet.
    const justPinged = {
        notifyUserId: NOTIFY_ID,
        lastPingAt: now - 1_000,
        lastPingPrice: 100,
    };
    assert.equal(shouldPing(justPinged, quote(150), { now }), false);

    // No notify target configured: never ping.
    assert.equal(shouldPing({ notifyUserId: null, lastPingAt: null }, quote(100)), false);
});

test('rendering pings only the tracked user and never @everyone', () => {
    const created = createSession({
        message: fakeMessage(),
        query: 'SOL',
        quote: quote(),
        guildId: 'g1',
        userId: 'u1',
        notifyUserId: NOTIFY_ID,
        position: { amount: 1000, entryPrice: 90 },
    });

    const payload = renderSession(created.session, quote(75.11), { ping: true });

    assert.ok(payload.content.includes(`<@${NOTIFY_ID}>`));
    assert.deepEqual(payload.allowedMentions, { users: [NOTIFY_ID], parse: [] });
    assert.equal(payload.embeds.length, 1);

    // The position must be recomputed against the live price, showing a loss.
    assert.ok(payload.position.profitLoss < 0);

    // A silent update carries no content and no mentions at all.
    const quiet = renderSession(created.session, quote(75.11), { ping: false });
    assert.equal(quiet.content, '');
    assert.deepEqual(quiet.allowedMentions.parse, []);
});

test('a live update edits the message and advances the counter', async () => {
    const message = fakeMessage();

    const created = createSession({
        message,
        query: 'SOL',
        quote: quote(),
        guildId: 'g1',
        userId: 'u1',
        notifyUserId: NOTIFY_ID,
        intervalMs: 15_000,
        durationMs: 60_000,
    });

    const session = created.session;

    // Drive one update directly rather than waiting on the real timer.
    const { __testables } = await import('../src/services/trading/tradeSessionManager.js');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ([{
            id: 'solana',
            symbol: 'sol',
            name: 'Solana',
            current_price: 80,
            market_cap: 44e9,
            total_volume: 1e9,
            high_24h: 81,
            low_24h: 73,
            price_change_percentage_24h_in_currency: 5.2,
            last_updated: new Date().toISOString(),
        }]),
    });

    try {
        await __testables.applyUpdate(session);

        assert.equal(session.updateCount, 1);
        assert.equal(session.lastQuote.price, 80);
        assert.ok(message.edits.length >= 1);

        const last = message.edits[message.edits.length - 1];
        assert.ok(Array.isArray(last.embeds));
        assert.ok(last.components);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    clearScannerCache,
    scanMemeMarket,
    scoreMemeCoin,
} = await import('../src/services/trading/memeScanner.js');

const rawCoin = (overrides = {}) => ({
    id: 'dog-coin',
    name: 'Dog Coin',
    symbol: 'dog',
    current_price: 0.01,
    market_cap: 100_000_000,
    total_volume: 20_000_000,
    price_change_percentage_1h_in_currency: 2,
    price_change_percentage_24h_in_currency: 12,
    price_change_percentage_7d_in_currency: 20,
    market_cap_rank: 150,
    ...overrides,
});

test.beforeEach(clearScannerCache);

test('balanced momentum with real participation outranks a thin micro-cap pump', () => {
    const balanced = scoreMemeCoin({
        change1h: 2, change24h: 12, change7d: 20,
        marketCap: 100_000_000, volume24h: 20_000_000,
    });
    const pump = scoreMemeCoin({
        change1h: 80, change24h: 300, change7d: 400,
        marketCap: 400_000, volume24h: 30_000,
    });

    assert.ok(balanced.score > pump.score, `${balanced.score} should beat ${pump.score}`);
    assert.equal(pump.risk, 'Very high');
    assert.ok(pump.warnings.some((warning) => warning.includes('micro-cap')));
});

test('scanner filters inactive coins and returns separate ranked views', async () => {
    const payload = [
        rawCoin(),
        rawCoin({ id: 'fast', symbol: 'fast', price_change_percentage_24h_in_currency: 45 }),
        rawCoin({ id: 'dead', symbol: 'dead', market_cap: 100_000, total_volume: 100 }),
    ];
    const transport = async () => ({ ok: true, status: 200, json: async () => payload });

    const scan = await scanMemeMarket({ force: true, transport, now: 1234 });

    assert.equal(scan.scanned, 3);
    assert.equal(scan.active, 2);
    assert.equal(scan.movers[0].symbol, 'FAST');
    assert.ok(scan.setups.every((coin) => coin.symbol !== 'DEAD'));
    assert.match(scan.methodology, /Momentum/);
});

test('scanner caches repeated reads to protect the upstream API', async () => {
    let calls = 0;
    const transport = async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => [rawCoin()] };
    };

    await scanMemeMarket({ transport, now: 10_000 });
    await scanMemeMarket({ transport, now: 10_001 });
    assert.equal(calls, 1);
});

test('provider failures become safe retryable market errors', async () => {
    const transport = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(
        scanMemeMarket({ force: true, transport }),
        (error) => error.code === 'upstream_error' && error.retryable,
    );
});

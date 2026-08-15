import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    SIGNAL_LIMITS,
    buildSignal,
    buildSignalScenarios,
    buildSimulationScenarios,
    isHeadingUp,
    projectScenarios,
    resolveSignalBudget,
    selectSignalCandidates,
    suggestStake,
} = await import('../src/services/trading/signalEngine.js');

const scanCoin = (overrides = {}) => ({
    id: 'test-coin',
    name: 'Test Coin',
    symbol: 'TEST',
    price: 0.01,
    marketCap: 100_000_000,
    volume24h: 20_000_000,
    change1h: 2,
    change24h: 12,
    change7d: 20,
    score: 72,
    risk: 'High',
    reasons: ['1h and 24h momentum agree'],
    warnings: [],
    ...overrides,
});

const scanWith = (coins) => ({ setups: coins, movers: coins, source: 'test' });

test('isHeadingUp requires positive 24h momentum and non-negative 1h', () => {
    assert.equal(isHeadingUp({ change1h: 1, change24h: 5 }), true);
    assert.equal(isHeadingUp({ change1h: null, change24h: 5 }), true, 'missing 1h is tolerated');
    assert.equal(isHeadingUp({ change1h: -2, change24h: 5 }), false);
    assert.equal(isHeadingUp({ change1h: 2, change24h: -5 }), false);
    assert.equal(isHeadingUp({ change1h: 2, change24h: 0 }), false);
    assert.equal(isHeadingUp({ change1h: 2, change24h: null }), false);
});

test('candidates must be heading up, unextended and above the quality bar', () => {
    const good = scanCoin({ id: 'good', score: 72, change24h: 12 });
    const down = scanCoin({ id: 'down', score: 80, change24h: -4 });
    const extended = scanCoin({ id: 'extended', score: 80, change24h: 200 });
    const weak = scanCoin({ id: 'weak', score: 40, change24h: 8 });

    const candidates = selectSignalCandidates(scanWith([good, down, extended, weak]));

    assert.deepEqual(candidates.map((c) => c.id), ['good']);
});

test('candidates sort by score, capped at the limit', () => {
    const coins = [
        scanCoin({ id: 'a', score: 60, change24h: 30 }),
        scanCoin({ id: 'b', score: 85, change24h: 5 }),
        scanCoin({ id: 'c', score: 75, change24h: 8 }),
        scanCoin({ id: 'd', score: 70, change24h: 9 }),
        scanCoin({ id: 'e', score: 65, change24h: 10 }),
    ];

    const candidates = selectSignalCandidates(scanWith(coins));

    assert.equal(candidates.length, SIGNAL_LIMITS.MAX_CANDIDATES);
    assert.deepEqual(candidates.map((c) => c.id), ['b', 'c', 'd']);
});

test('duplicate coins across setups and movers are deduplicated', () => {
    const coin = scanCoin({ id: 'dupe' });
    const candidates = selectSignalCandidates({ setups: [coin], movers: [{ ...coin }], source: 'test' });

    assert.equal(candidates.length, 1);
});

test('stake sizing scales with market cap depth', () => {
    const budget = 100;

    const deep = suggestStake(scanCoin({ marketCap: 800_000_000 }), budget);
    const mid = suggestStake(scanCoin({ marketCap: 60_000_000 }), budget);
    const small = suggestStake(scanCoin({ marketCap: 12_000_000 }), budget);
    const micro = suggestStake(scanCoin({ marketCap: 2_000_000 }), budget);

    assert.equal(deep.amount, 100);
    assert.equal(mid.amount, 75);
    assert.equal(small.amount, 50);
    assert.equal(micro.amount, 30);

    // Every size stays within the budget.
    for (const sized of [deep, mid, small, micro]) {
        assert.ok(sized.amount <= budget);
        assert.ok(sized.reason.length > 0);
    }
});

test('scanner flags halve the suggested stake', () => {
    const flagged = suggestStake(scanCoin({ marketCap: 800_000_000, warnings: ['thin daily volume'] }), 100);
    const clean = suggestStake(scanCoin({ marketCap: 800_000_000 }), 100);

    assert.equal(clean.amount, 100);
    assert.equal(flagged.amount, 50);
    assert.match(flagged.reason, /halved/);
});

test('stake sizing never leaves the sane range', () => {
    const tinyBudget = suggestStake(scanCoin({ marketCap: 500 }), SIGNAL_LIMITS.MIN_BUDGET);
    assert.ok(tinyBudget.amount >= 1);
    assert.ok(tinyBudget.amount <= SIGNAL_LIMITS.MIN_BUDGET);

    const unknownCap = suggestStake(scanCoin({ marketCap: null }), 100);
    assert.equal(unknownCap.amount, 25, 'unknown cap gets a conservative quarter-size');
});

test('projectScenarios is exact arithmetic', () => {
    const rows = projectScenarios(100, [1.5, 2, 5]);

    assert.deepEqual(rows.map((r) => r.value), [150, 200, 500]);
    assert.deepEqual(rows.map((r) => r.profit), [50, 100, 400]);
    assert.deepEqual(projectScenarios(0, [2]), []);
    assert.deepEqual(projectScenarios(null, [2]), []);
});

test('signal scenarios include today-pace repeat and merge near-duplicates', () => {
    const coin = scanCoin({ change24h: 50, price: 1, ath: 2.05 });
    const scenarios = buildSignalScenarios(coin, 100);

    const labels = scenarios.map((s) => s.label);
    assert.ok(labels.includes('Repeats today'), labels.join(','));
    // +50% and "repeats today at +50%" are the same move — one row only.
    assert.equal(scenarios.filter((s) => Math.abs(s.multiplier - 1.5) < 0.01).length, 1);
    // ATH at 2.05x is within 8% of the 2x row — merged, not duplicated.
    assert.equal(scenarios.filter((s) => Math.abs(s.multiplier - 2) < 0.2).length, 1);

    for (const scenario of scenarios) {
        assert.ok(Math.abs(scenario.value - 100 * scenario.multiplier) < 1e-9);
        assert.ok(Math.abs(scenario.profit - (scenario.value - 100)) < 1e-9);
    }
});

test('simulation ladder covers the standard multiples plus ATH', () => {
    const quote = { price: 1, ath: 7 };
    const scenarios = buildSimulationScenarios(quote, 10);

    const labels = scenarios.map((s) => s.label);
    for (const expected of ['1.25x', '1.5x', '2x', '3x', '5x', '10x', 'Retests ATH']) {
        assert.ok(labels.includes(expected), `missing ${expected} in ${labels.join(',')}`);
    }

    const ath = scenarios.find((s) => s.label === 'Retests ATH');
    assert.equal(ath.multiplier, 7);
    assert.equal(ath.value, 70);
});

test('buildSignal returns null when nothing qualifies, otherwise the top pick', () => {
    assert.equal(buildSignal({ scan: scanWith([scanCoin({ change24h: -10 })]), budget: 100 }), null);

    const signal = buildSignal({
        scan: scanWith([
            scanCoin({ id: 'second', score: 62, change24h: 6 }),
            scanCoin({ id: 'first', score: 88, change24h: 14 }),
        ]),
        budget: 100,
    });

    assert.equal(signal.primary.id, 'first');
    assert.equal(signal.candidates.length, 1);
    assert.equal(signal.budget, 100);
    assert.ok(signal.stake.amount > 0);
    assert.ok(signal.scenarios.length > 0);
});

test('resolveSignalBudget honours env and clamps', () => {
    assert.equal(resolveSignalBudget({}), SIGNAL_LIMITS.DEFAULT_BUDGET);
    assert.equal(resolveSignalBudget({ TRADE_SIGNAL_BUDGET: '250' }), 250);
    assert.equal(resolveSignalBudget({ TRADE_SIGNAL_BUDGET: 'junk' }), SIGNAL_LIMITS.DEFAULT_BUDGET);
    assert.equal(resolveSignalBudget({ TRADE_SIGNAL_BUDGET: '1' }), SIGNAL_LIMITS.MIN_BUDGET);
    assert.equal(resolveSignalBudget({ TRADE_SIGNAL_BUDGET: '999999999' }), SIGNAL_LIMITS.MAX_BUDGET);
});

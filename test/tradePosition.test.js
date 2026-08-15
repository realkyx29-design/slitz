import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    POSITION_LIMITS,
    calculatePosition,
    calculateTwentyFourHourWhatIf,
    validatePosition,
} = await import('../src/services/trading/positionCalculator.js');

const close = (actual, expected, epsilon = 1e-9) =>
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} !== ${expected}`);

test('profit is exact when the price rises', () => {
    const result = calculatePosition({ amount: 1000, entryPrice: 60, currentPrice: 75 });

    close(result.units, 1000 / 60);
    close(result.currentValue, 1250);
    close(result.profitLoss, 250);
    close(result.profitLossPercent, 25);
    assert.equal(result.direction, 'up');
    assert.equal(result.isProfit, true);
    assert.equal(result.breakEven, false);
});

test('loss is exact when the price falls', () => {
    const result = calculatePosition({ amount: 1000, entryPrice: 90, currentPrice: 75 });

    close(result.currentValue, (1000 / 90) * 75);
    close(result.profitLoss, (1000 / 90) * 75 - 1000);
    close(result.profitLossPercent, ((75 - 90) / 90) * 100);
    assert.equal(result.direction, 'down');
    assert.equal(result.isProfit, false);
});

test('value never drifts from units times current price', () => {
    // The headline number must equal the arithmetic shown on the card.
    const cases = [
        [500, 0.00002, 0.00002392],
        [25, 0.13, 0.09],
        [1_000_000, 1, 1],
        [10, 1e-9, 5e-9],
    ];

    for (const [amount, entryPrice, currentPrice] of cases) {
        const r = calculatePosition({ amount, entryPrice, currentPrice });
        close(r.currentValue, r.units * currentPrice, Math.abs(r.currentValue) * 1e-9 + 1e-9);
        close(r.profitLoss, r.currentValue - amount, Math.abs(r.currentValue) * 1e-9 + 1e-9);
    }
});

test('break-even is flagged rather than shown as a tiny gain', () => {
    const result = calculatePosition({ amount: 1000, entryPrice: 42, currentPrice: 42 });

    close(result.profitLoss, 0);
    close(result.profitLossPercent, 0);
    assert.equal(result.breakEven, true);
    assert.equal(result.direction, 'flat');
});

test('a total wipeout reports -100% rather than dividing by zero', () => {
    const result = calculatePosition({ amount: 1000, entryPrice: 5, currentPrice: 0 });

    close(result.currentValue, 0);
    close(result.profitLoss, -1000);
    close(result.profitLossPercent, -100);
    assert.equal(result.isProfit, false);
});

test('a zero or negative entry price is rejected, not divided by', () => {
    assert.equal(calculatePosition({ amount: 100, entryPrice: 0, currentPrice: 5 }), null);
    assert.equal(calculatePosition({ amount: 100, entryPrice: -1, currentPrice: 5 }), null);
    assert.equal(calculatePosition({ amount: 0, entryPrice: 1, currentPrice: 5 }), null);
    assert.equal(calculatePosition({ amount: null, entryPrice: 1, currentPrice: 5 }), null);
});

test('validatePosition guards the input range', () => {
    assert.equal(validatePosition({ amount: 100, entryPrice: 1 }).ok, true);
    assert.equal(validatePosition({ amount: -5, entryPrice: 1 }).ok, false);
    assert.equal(validatePosition({ amount: 0, entryPrice: 1 }).ok, false);
    assert.equal(validatePosition({ amount: Number.NaN, entryPrice: 1 }).ok, false);

    const tooBig = validatePosition({ amount: POSITION_LIMITS.MAX_AMOUNT * 10, entryPrice: 1 });
    assert.equal(tooBig.ok, false);
    assert.ok(tooBig.reason);
});

test('24h what-if inverts the percentage move correctly', () => {
    // Up 25% means the price 24h ago was current / 1.25, not current * 0.75.
    const up = calculateTwentyFourHourWhatIf({
        amount: 1000,
        currentPrice: 125,
        changePercent24h: 25,
    });

    close(up.profitLossPercent, 25);
    close(up.currentValue, 1250);
    assert.equal(up.isProfit, true);

    const down = calculateTwentyFourHourWhatIf({
        amount: 1000,
        currentPrice: 75,
        changePercent24h: -25,
    });

    close(down.profitLossPercent, -25);
    close(down.currentValue, 750);
    assert.equal(down.isProfit, false);
});

test('24h what-if degrades safely on missing or impossible data', () => {
    assert.equal(calculateTwentyFourHourWhatIf({
        amount: 1000, currentPrice: 10, changePercent24h: null,
    }), null);

    // -100% would imply a zero price 24h ago.
    assert.equal(calculateTwentyFourHourWhatIf({
        amount: 1000, currentPrice: 10, changePercent24h: -100,
    }), null);
});

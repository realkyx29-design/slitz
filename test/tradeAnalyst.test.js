import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    ANALYST_LIMITS,
    analyzeMarket,
    buildAnalysisPrompt,
    clearAnalysisCache,
    isAnalystEnabled,
    sanitizeAnalysis,
} = await import('../src/services/trading/tradeAnalyst.js');

const quote = {
    id: 'solana',
    name: 'Solana',
    symbol: 'SOL',
    source: 'coingecko',
    price: 75.11,
    change1h: 0.1,
    change24h: -1.4,
    change7d: 1.8,
    high24h: 77.36,
    low24h: 73.59,
    marketCap: 43.77e9,
    volume24h: 1.08e9,
    rank: 5,
    athChangePercent: -71.1,
    chain: null,
    lastUpdated: Date.now(),
};

const envWithKey = {
    AI_API_KEY: 'sk-test-key-000000000000000000000000',
    TRADE_AI_ENABLED: 'true',
};

test.beforeEach(() => clearAnalysisCache());

test('the analyst is disabled without an API key and by the kill switch', () => {
    assert.equal(isAnalystEnabled({}), false);
    assert.equal(isAnalystEnabled(envWithKey), true);
    assert.equal(
        isAnalystEnabled({ ...envWithKey, TRADE_AI_ENABLED: 'false' }),
        false,
        'TRADE_AI_ENABLED=false must hard-disable the analyst',
    );
});

test('the prompt carries only market data, never credentials or actions', () => {
    const prompt = buildAnalysisPrompt(quote, {
        amount: 1000,
        entryPrice: 90,
        currentValue: 834.56,
        profitLoss: -165.44,
        profitLossPercent: -16.54,
    });

    assert.ok(prompt.includes('Solana'));
    assert.ok(prompt.includes('$75.11'));
    assert.ok(prompt.includes('-1.40%'));
    assert.ok(prompt.includes('hypothetical'));
    assert.ok(/no advice|no predictions/i.test(prompt));
    assert.ok(!prompt.includes('sk-test'));
});

test('nulls in the quote are omitted rather than sent as "null"', () => {
    const sparse = buildAnalysisPrompt({
        name: 'Ghost', symbol: 'GHST', price: 0.5,
        change1h: null, change24h: null, change7d: null,
        high24h: null, low24h: null, marketCap: null,
        volume24h: null, liquidity: null, rank: null,
        athChangePercent: null, chain: null,
    });

    assert.ok(!/null|undefined|NaN/.test(sparse), sparse);
});

test('analyzeMarket returns null instead of throwing when the provider fails', async () => {
    const result = await analyzeMarket(quote, null, {
        env: envWithKey,
        transport: async () => { throw new Error('provider exploded'); },
    });

    assert.equal(result, null);
});

test('analyzeMarket returns null when no AI is configured', async () => {
    let called = false;

    const result = await analyzeMarket(quote, null, {
        env: {},
        transport: async () => { called = true; return {}; },
    });

    assert.equal(result, null);
    assert.equal(called, false, 'must not call the provider when disabled');
});

test('a normal reply is passed through and length-capped', async () => {
    const long = 'Volume is elevated against a falling price. '.repeat(80);

    const result = await analyzeMarket(quote, null, {
        env: envWithKey,
        // requestAiCompletion's transport resolves to the response body itself.
        transport: async () => ({ choices: [{ message: { content: long } }] }),
    });

    assert.ok(result);
    assert.ok(result.length <= ANALYST_LIMITS.MAX_CHARS, `got ${result.length}`);
});

test('sanitizeAnalysis strips any attempt to sound like it can trade', () => {
    const dangerous = [
        'I have bought 1000 SOL for you.',
        'Executing your buy order now.',
        'Transferring funds to your wallet.',
    ];

    for (const text of dangerous) {
        // These claims are always false — the bot has no execution surface —
        // so the analysis must be discarded entirely.
        assert.equal(sanitizeAnalysis(text), null, `sanitizer let through: ${text}`);
    }

    // Legitimate market commentary must still pass through untouched.
    const fine = 'Volume is elevated while price drifts lower, and liquidity looks thin.';
    assert.equal(sanitizeAnalysis(fine), fine);
});

test('analysis is cached so repeated reads do not re-bill the provider', async () => {
    let calls = 0;
    const transport = async () => {
        calls += 1;
        return { choices: [{ message: { content: 'Range-bound on light volume.' } }] };
    };

    const first = await analyzeMarket(quote, null, { env: envWithKey, transport });
    const second = await analyzeMarket(quote, null, { env: envWithKey, transport });

    assert.equal(first, second);
    assert.equal(calls, 1, 'second call should be served from cache');
});

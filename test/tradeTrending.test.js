import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    clearMarketCaches,
    fetchTopBoostedTokens,
    MarketDataError,
} = await import('../src/services/trading/marketDataService.js');

const {
    clearTrendingCache,
    dedupeBoosts,
    getTrendingTokens,
    TRENDING_LIMITS,
} = await import('../src/services/trading/memeTrending.js');

const ADDRESS_A = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJJJJKKKKLLLL';
const ADDRESS_B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function stubFetch(router) {
    const calls = [];
    const original = globalThis.fetch;

    globalThis.fetch = async (url) => {
        const href = String(url);
        calls.push(href);
        const result = router(href);

        if (!result) {
            return { ok: false, status: 404, json: async () => ({}) };
        }

        if (typeof result === 'number') {
            return { ok: false, status: result, json: async () => ({}) };
        }

        return { ok: true, status: 200, json: async () => result };
    };

    return {
        calls,
        restore() { globalThis.fetch = original; },
    };
}

const boostsPayload = () => ([
    { chainId: 'solana', tokenAddress: ADDRESS_A, amount: 100, totalAmount: 500 },
    { chainId: 'solana', tokenAddress: ADDRESS_B, amount: 50, totalAmount: 300 },
]);

const dexPair = (address, overrides = {}) => ({
    chainId: 'solana',
    dexId: 'raydium',
    url: `https://dexscreener.com/solana/${address}`,
    baseToken: { address, name: 'Boosted Token', symbol: 'BOOST' },
    priceUsd: '0.001',
    priceChange: { h1: 3, h24: 25 },
    volume: { h24: 500_000 },
    liquidity: { usd: 120_000 },
    marketCap: 5_000_000,
    ...overrides,
});

test.beforeEach(() => {
    clearMarketCaches();
    clearTrendingCache();
});

test('dedupeBoosts keeps the largest boost per chain+address', () => {
    const deduped = dedupeBoosts([
        { chainId: 'solana', tokenAddress: ADDRESS_A, totalAmount: 100 },
        { chainId: 'solana', tokenAddress: ADDRESS_A.toLowerCase(), totalAmount: 400 },
        { chainId: 'ethereum', tokenAddress: ADDRESS_A, totalAmount: 200 },
    ]);

    assert.equal(deduped.length, 2);
    const sol = deduped.find((b) => b.chainId === 'solana');
    assert.equal(sol.totalAmount, 400);
});

test('fetchTopBoostedTokens normalises the payload and drops malformed rows', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('/token-boosts/top/v1')) {
            return [
                ...boostsPayload(),
                { chainId: 'solana' }, // missing address — dropped
                null,
            ];
        }
        return null;
    });

    try {
        const boosts = await fetchTopBoostedTokens();
        assert.equal(boosts.length, 2);
        assert.equal(boosts[0].chainId, 'solana');
        assert.equal(boosts[0].amount, 100);
    } finally {
        stub.restore();
    }
});

test('fetchTopBoostedTokens rejects a non-array payload', async () => {
    const stub = stubFetch(() => ({ unexpected: true }));

    try {
        await assert.rejects(fetchTopBoostedTokens(), MarketDataError);
    } finally {
        stub.restore();
    }
});

test('trending board hydrates boosts with live quotes, sorted by 24h move', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('/token-boosts/top/v1')) return boostsPayload();
        if (url.includes(`/tokens/${ADDRESS_A}`)) {
            return { pairs: [dexPair(ADDRESS_A, { priceChange: { h1: 1, h24: 40 } })] };
        }
        if (url.includes(`/tokens/${ADDRESS_B}`)) {
            return { pairs: [dexPair(ADDRESS_B, { baseToken: { address: ADDRESS_B, name: 'Bonk', symbol: 'BONK' }, priceChange: { h1: 2, h24: 10 } })] };
        }
        return null;
    });

    try {
        const trending = await getTrendingTokens({ force: true });

        assert.equal(trending.entries.length, 2);
        // Sorted by 24h change, descending.
        assert.equal(trending.entries[0].quote.symbol, 'BOOST');
        assert.equal(trending.entries[1].quote.symbol, 'BONK');

        for (const entry of trending.entries) {
            assert.ok(entry.risk, 'every entry carries a risk label');
            assert.ok(typeof entry.score === 'number');
            assert.ok(entry.url.includes('dexscreener.com'));
            assert.ok(entry.chain, 'chain label is derived');
        }
    } finally {
        stub.restore();
    }
});

test('tokens below the liquidity floor are dropped', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('/token-boosts/top/v1')) {
            return [{ chainId: 'solana', tokenAddress: ADDRESS_A, totalAmount: 100 }];
        }
        if (url.includes(`/tokens/${ADDRESS_A}`)) {
            return { pairs: [dexPair(ADDRESS_A, { liquidity: { usd: 500 } })] };
        }
        return null;
    });

    try {
        const trending = await getTrendingTokens({ force: true });
        assert.equal(trending.entries.length, 0);
    } finally {
        stub.restore();
    }
});

test('a dead token fails the whole lookup gracefully instead of throwing', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('/token-boosts/top/v1')) {
            return [
                { chainId: 'solana', tokenAddress: ADDRESS_A, totalAmount: 100 },
                { chainId: 'solana', tokenAddress: ADDRESS_B, totalAmount: 50 },
            ];
        }
        if (url.includes(`/tokens/${ADDRESS_B}`)) {
            return { pairs: [dexPair(ADDRESS_B)] };
        }
        return null; // ADDRESS_A 404s — should simply drop out.
    });

    try {
        const trending = await getTrendingTokens({ force: true });
        assert.equal(trending.entries.length, 1);
    } finally {
        stub.restore();
    }
});

test('trending results are cached until force is passed', async () => {
    let boostCalls = 0;
    const stub = stubFetch((url) => {
        if (url.includes('/token-boosts/top/v1')) {
            boostCalls += 1;
            return [{ chainId: 'solana', tokenAddress: ADDRESS_B, totalAmount: 50 }];
        }
        if (url.includes(`/tokens/${ADDRESS_B}`)) {
            return { pairs: [dexPair(ADDRESS_B)] };
        }
        return null;
    });

    try {
        await getTrendingTokens({ force: true });
        await getTrendingTokens();
        await getTrendingTokens();
        assert.equal(boostCalls, 1, 'cached reads must not re-hit the boosts endpoint');

        await getTrendingTokens({ force: true });
        assert.equal(boostCalls, 2);
    } finally {
        stub.restore();
    }
});

test('an empty boost universe surfaces a retryable error', async () => {
    const stub = stubFetch(() => []);

    try {
        await assert.rejects(
            getTrendingTokens({ force: true }),
            (error) => error instanceof MarketDataError && error.code === 'empty_universe',
        );
    } finally {
        stub.restore();
    }
});

test('the hydration cap keeps API usage bounded', () => {
    assert.ok(TRENDING_LIMITS.MAX_TOKENS <= 10, 'boost hydration must stay small');
});

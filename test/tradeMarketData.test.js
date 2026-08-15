import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    MarketDataError,
    clearMarketCaches,
    getQuote,
    isContractAddress,
    normalizeQuery,
    selectBestPair,
} = await import('../src/services/trading/marketDataService.js');

const BONK_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** Stub global fetch with a url -> payload router. */
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

const coingeckoMarket = (overrides = {}) => ([{
    id: 'bonk',
    symbol: 'bonk',
    name: 'Bonk',
    image: 'https://example.com/bonk.png',
    current_price: 2.392e-5,
    market_cap: 210_000_000,
    market_cap_rank: 62,
    fully_diluted_valuation: 250_000_000,
    total_volume: 45_000_000,
    high_24h: 2.5e-5,
    low_24h: 2.2e-5,
    price_change_percentage_24h: -3.2,
    price_change_percentage_1h_in_currency: 0.4,
    price_change_percentage_24h_in_currency: -3.2,
    price_change_percentage_7d_in_currency: 12.8,
    ath: 4.5e-5,
    ath_change_percentage: -46.8,
    ath_date: '2024-03-05T00:00:00.000Z',
    last_updated: '2026-08-14T00:00:00.000Z',
    sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => 2.0e-5 + i * 1e-8) },
    ...overrides,
}]);

test.beforeEach(() => clearMarketCaches());

test('isContractAddress recognises EVM and Solana addresses only', () => {
    assert.equal(isContractAddress(`0x${'a'.repeat(40)}`), true);
    assert.equal(isContractAddress(BONK_ADDRESS), true);
    assert.equal(isContractAddress('BONK'), false);
    assert.equal(isContractAddress('dogwifhat'), false);
    assert.equal(isContractAddress('0x123'), false);
});

test('normalizeQuery strips the leading dollar sign traders type', () => {
    assert.equal(normalizeQuery('$BONK'), 'BONK');
    assert.equal(normalizeQuery('  bonk  '), 'bonk');
    assert.equal(normalizeQuery(''), '');
    assert.equal(normalizeQuery(null), '');
});

test('a known ticker skips /search and maps straight to a coin id', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('/search')) {
            throw new Error('should not call /search for a shortcut ticker');
        }
        if (url.includes('/coins/markets')) return coingeckoMarket();
        return null;
    });

    try {
        const quote = await getQuote('BONK');

        assert.equal(quote.symbol, 'BONK');
        assert.equal(quote.source, 'coingecko');
        assert.equal(quote.price, 2.392e-5);
        assert.equal(quote.rank, 62);
        assert.equal(quote.change24h, -3.2);
        assert.equal(quote.change7d, 12.8);
        assert.ok(quote.sparkline.length > 100);
        assert.ok(stub.calls.every((c) => !c.includes('/search')));
    } finally {
        stub.restore();
    }
});

test('quotes are cached, then bypassed with force', async () => {
    let marketCalls = 0;
    const stub = stubFetch((url) => {
        if (url.includes('/coins/markets')) {
            marketCalls += 1;
            return coingeckoMarket();
        }
        return null;
    });

    try {
        const first = await getQuote('BONK');
        assert.equal(first.cached, false);

        const second = await getQuote('BONK');
        assert.equal(second.cached, true);
        assert.equal(marketCalls, 1, 'second call should hit the cache');

        const forced = await getQuote('BONK', { force: true });
        assert.equal(forced.cached, false);
        assert.equal(marketCalls, 2, 'force should refetch');
    } finally {
        stub.restore();
    }
});

test('a contract address resolves through DexScreener', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('dexscreener')) {
            return {
                pairs: [{
                    chainId: 'solana',
                    dexId: 'raydium',
                    url: 'https://dexscreener.com/solana/x',
                    baseToken: { address: BONK_ADDRESS, name: 'Bonk', symbol: 'BONK' },
                    quoteToken: { address: 'So111', name: 'Wrapped SOL', symbol: 'SOL' },
                    priceUsd: '0.00002392',
                    priceChange: { h1: 0.5, h24: -3.2 },
                    volume: { h24: 45_000_000 },
                    liquidity: { usd: 8_000_000 },
                    marketCap: 210_000_000,
                    fdv: 250_000_000,
                }],
            };
        }
        return null;
    });

    try {
        const quote = await getQuote(BONK_ADDRESS);

        assert.equal(quote.source, 'dexscreener');
        assert.equal(quote.symbol, 'BONK');
        // priceUsd arrives as a string and must be coerced to a number.
        assert.equal(quote.price, 0.00002392);
        assert.equal(quote.chain, 'solana');
        assert.equal(quote.change24h, -3.2);
    } finally {
        stub.restore();
    }
});

test('selectBestPair ignores the mispriced low-liquidity pair', () => {
    // Regression guard: a real BONK query returned a Meteora DLMM pair quoting
    // $0.01233 (~5000x the true price). Taking pairs[0] would report a market
    // cap of $1.08T. Highest-liquidity wins instead.
    const pairs = [
        {
            chainId: 'solana',
            baseToken: { address: BONK_ADDRESS, symbol: 'BONK' },
            quoteToken: { symbol: 'JUP' },
            priceUsd: '0.01233',
            liquidity: { usd: 1_200 },
            marketCap: 1_085_282_911_130,
        },
        {
            chainId: 'solana',
            baseToken: { address: BONK_ADDRESS, symbol: 'BONK' },
            quoteToken: { symbol: 'SOL' },
            priceUsd: '0.00002392',
            liquidity: { usd: 8_000_000 },
            marketCap: 210_000_000,
        },
    ];

    const best = selectBestPair(pairs, BONK_ADDRESS);

    assert.equal(best.priceUsd, '0.00002392');
    assert.equal(best.liquidity.usd, 8_000_000);
});

test('selectBestPair rejects pairs for a different token', () => {
    const pairs = [{
        baseToken: { address: 'SomeOtherMintAddress1111111111111111111111', symbol: 'FAKE' },
        quoteToken: { symbol: 'SOL' },
        priceUsd: '9.99',
        liquidity: { usd: 50_000_000 },
    }];

    assert.equal(selectBestPair(pairs, BONK_ADDRESS), null);
});

test('an unknown coin returns null instead of throwing', async () => {
    const stub = stubFetch((url) => {
        if (url.includes('/search')) return { coins: [] };
        if (url.includes('dexscreener')) return { pairs: [] };
        return null;
    });

    try {
        assert.equal(await getQuote('definitelynotarealcoin99'), null);
    } finally {
        stub.restore();
    }
});

test('rate limiting surfaces as a retryable MarketDataError', async () => {
    const stub = stubFetch(() => 429);

    try {
        await assert.rejects(
            () => getQuote('BONK'),
            (error) => {
                assert.ok(error instanceof MarketDataError);
                assert.equal(error.code, 'rate_limited');
                assert.equal(error.retryable, true);
                return true;
            },
        );
    } finally {
        stub.restore();
    }
});

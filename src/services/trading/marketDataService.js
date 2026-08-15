// marketDataService.js — read-only market data for the /trade command.
//
// Two upstreams, chosen automatically:
//   • CoinGecko    — listed coins (rank, market cap, ATH, 24h high/low, 7d sparkline)
//   • DexScreener  — on-chain pairs by contract address (new pump.fun / SPL tokens)
//
// This service ONLY reads public market data. It holds no keys, signs nothing,
// and has no code path that could place an order or move funds.

import { logger } from '../../utils/logger.js';
import { toNumber } from '../../utils/tradeFormat.js';

const COINGECKO_BASE = process.env.COINGECKO_API_BASE || 'https://api.coingecko.com/api/v3';
const DEXSCREENER_BASE = process.env.DEXSCREENER_API_BASE || 'https://api.dexscreener.com/latest/dex';

export const MARKET_SOURCES = {
    COINGECKO: 'coingecko',
    DEXSCREENER: 'dexscreener',
};

export const MARKET_LIMITS = {
    REQUEST_TIMEOUT_MS: 12_000,
    QUOTE_CACHE_MS: 15_000,      // dedupe bursts of refreshes for the same coin
    RESOLVE_CACHE_MS: 30 * 60 * 1000, // symbol -> coin id rarely changes
    MAX_CACHE_ENTRIES: 500,
};

/** Contract addresses: EVM (0x + 40 hex) or Solana base58 (32-44 chars). */
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Well-known memecoins, so common tickers skip the ambiguous search endpoint. */
const SYMBOL_SHORTCUTS = new Map(Object.entries({
    doge: 'dogecoin',
    shib: 'shiba-inu',
    pepe: 'pepe',
    bonk: 'bonk',
    wif: 'dogwifcoin',
    dogwifhat: 'dogwifcoin',
    floki: 'floki',
    brett: 'based-brett',
    popcat: 'popcat',
    mew: 'cat-in-a-dogs-world',
    fartcoin: 'fartcoin',
    pnut: 'peanut-the-squirrel',
    goat: 'goatseus-maximus',
    trump: 'official-trump',
    spx: 'spx6900',
    mog: 'mog-coin',
    turbo: 'turbo',
    neiro: 'neiro-3',
    act: 'act-i-the-ai-prophecy',
    ai16z: 'ai16z',
    sol: 'solana',
    btc: 'bitcoin',
    eth: 'ethereum',
}));

const quoteCache = new Map();
const resolveCache = new Map();

function pruneCache(cache) {
    if (cache.size <= MARKET_LIMITS.MAX_CACHE_ENTRIES) {
        return;
    }

    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) {
            cache.delete(key);
        }
    }

    // Still oversized (all entries fresh): drop oldest insertions.
    while (cache.size > MARKET_LIMITS.MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        cache.delete(oldestKey);
    }
}

function readCache(cache, key) {
    const entry = cache.get(key);

    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }

    return entry.value;
}

function writeCache(cache, key, value, ttlMs) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    pruneCache(cache);
}

/** Clear all cached market data (used by tests). */
export function clearMarketCaches() {
    quoteCache.clear();
    resolveCache.clear();
}

/** True when the query looks like an on-chain contract address. */
export function isContractAddress(query) {
    const value = String(query || '').trim();
    return EVM_ADDRESS.test(value) || SOLANA_ADDRESS.test(value);
}

export function normalizeQuery(query) {
    return String(query || '').trim().replace(/^\$/, '');
}

class MarketDataError extends Error {
    constructor(message, { code = 'market_error', retryable = false } = {}) {
        super(message);
        this.name = 'MarketDataError';
        this.code = code;
        this.retryable = retryable;
    }
}

export { MarketDataError };

async function fetchJson(url, { timeoutMs = MARKET_LIMITS.REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'TitanBot/2.1 (+trade-command)',
            },
        });

        if (response.status === 429) {
            throw new MarketDataError('The market data provider is rate limiting us.', {
                code: 'rate_limited',
                retryable: true,
            });
        }

        if (response.status === 404) {
            throw new MarketDataError('That coin was not found.', { code: 'not_found' });
        }

        if (!response.ok) {
            throw new MarketDataError(`Market data provider returned HTTP ${response.status}.`, {
                code: 'upstream_error',
                retryable: response.status >= 500,
            });
        }

        return await response.json();
    } catch (error) {
        if (error instanceof MarketDataError) {
            throw error;
        }

        if (error?.name === 'AbortError') {
            throw new MarketDataError('The market data request timed out.', {
                code: 'timeout',
                retryable: true,
            });
        }

        throw new MarketDataError('Could not reach the market data provider.', {
            code: 'network_error',
            retryable: true,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolve a free-text query (name or ticker) to a CoinGecko coin id.
 * Results are ranked so the real coin wins over copycat tokens.
 */
export async function resolveCoinId(query) {
    const normalized = normalizeQuery(query).toLowerCase();

    if (!normalized) {
        return null;
    }

    const shortcut = SYMBOL_SHORTCUTS.get(normalized);
    if (shortcut) {
        return shortcut;
    }

    const cached = readCache(resolveCache, normalized);
    if (cached !== null) {
        return cached;
    }

    const data = await fetchJson(
        `${COINGECKO_BASE}/search?query=${encodeURIComponent(normalized)}`,
    );

    const coins = Array.isArray(data?.coins) ? data.coins : [];

    if (coins.length === 0) {
        return null;
    }

    // Prefer exact symbol/name matches that actually have a market cap rank;
    // unranked copycats ("dogwifhat2") sort last.
    const scored = coins.map((coin, index) => {
        const symbol = String(coin?.symbol || '').toLowerCase();
        const name = String(coin?.name || '').toLowerCase();
        const id = String(coin?.id || '').toLowerCase();
        const rank = toNumber(coin?.market_cap_rank);

        let score = 0;
        if (symbol === normalized) score += 100;
        if (name === normalized) score += 80;
        if (id === normalized) score += 60;
        if (name.startsWith(normalized)) score += 10;
        if (rank !== null) score += Math.max(0, 50 - Math.log10(Math.max(1, rank)) * 10);

        return { coin, score, order: index };
    });

    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));

    const best = scored[0]?.coin?.id || null;

    if (best) {
        writeCache(resolveCache, normalized, best, MARKET_LIMITS.RESOLVE_CACHE_MS);
    }

    return best;
}

function normalizeCoinGecko(raw) {
    const price = toNumber(raw?.current_price);

    if (price === null) {
        return null;
    }

    const sparkline = Array.isArray(raw?.sparkline_in_7d?.price)
        ? raw.sparkline_in_7d.price.map(toNumber).filter((value) => value !== null)
        : [];

    return {
        source: MARKET_SOURCES.COINGECKO,
        id: raw?.id || null,
        name: raw?.name || raw?.id || 'Unknown',
        symbol: String(raw?.symbol || '').toUpperCase(),
        image: raw?.image || null,
        price,
        change1h: toNumber(raw?.price_change_percentage_1h_in_currency),
        change24h: toNumber(raw?.price_change_percentage_24h_in_currency)
            ?? toNumber(raw?.price_change_percentage_24h),
        change7d: toNumber(raw?.price_change_percentage_7d_in_currency),
        high24h: toNumber(raw?.high_24h),
        low24h: toNumber(raw?.low_24h),
        marketCap: toNumber(raw?.market_cap),
        fdv: toNumber(raw?.fully_diluted_valuation),
        volume24h: toNumber(raw?.total_volume),
        rank: toNumber(raw?.market_cap_rank),
        ath: toNumber(raw?.ath),
        athChangePercent: toNumber(raw?.ath_change_percentage),
        athDate: raw?.ath_date || null,
        liquidity: null,
        chain: null,
        pairUrl: raw?.id ? `https://www.coingecko.com/en/coins/${raw.id}` : null,
        sparkline,
        lastUpdated: raw?.last_updated ? Date.parse(raw.last_updated) || Date.now() : Date.now(),
        fetchedAt: Date.now(),
    };
}

/**
 * Pick the pair that best represents a token: highest USD liquidity wins.
 *
 * DexScreener returns every pool the token trades in, including thin or
 * mispriced exotic-quote pools (a BONK/JUP pool once reported $0.0123 versus
 * the true $0.0000024). Liquidity-weighting avoids showing those.
 */
export function selectBestPair(pairs, options = {}) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
        return null;
    }

    // Accept either selectBestPair(pairs, address) or { address }.
    const address = typeof options === 'string' ? options : options.address;
    const target = address ? String(address).toLowerCase() : null;

    const priced = pairs.filter((pair) => pair && toNumber(pair.priceUsd) !== null);

    if (!target) {
        if (priced.length === 0) {
            return null;
        }

        return pickHighestLiquidity(priced);
    }

    // When an exact token was requested, only pairs for THAT token are valid.
    // Falling back to the full list here would happily price a different
    // token that merely showed up in the same search response.
    const usable = priced.filter(
        (pair) => String(pair?.baseToken?.address || '').toLowerCase() === target,
    );

    if (usable.length === 0) {
        return null;
    }

    return pickHighestLiquidity(usable);
}

/**
 * Deepest liquidity wins. Thin pools are where the absurd prices live: a real
 * BONK response contained a $1.2k-liquidity pair quoting ~5000x the true price,
 * which would have rendered a $1.08T market cap.
 */
function pickHighestLiquidity(pairs) {
    return pairs.reduce((best, pair) => {
        const bestLiquidity = toNumber(best?.liquidity?.usd) ?? 0;
        const pairLiquidity = toNumber(pair?.liquidity?.usd) ?? 0;
        return pairLiquidity > bestLiquidity ? pair : best;
    }, pairs[0]);
}

function normalizeDexScreener(pair) {
    const price = toNumber(pair?.priceUsd);

    if (price === null) {
        return null;
    }

    const change24h = toNumber(pair?.priceChange?.h24);

    // DexScreener has no 24h high/low field. Derive bounds from the 24h move so
    // the card still shows a meaningful range instead of blank fields.
    let high24h = null;
    let low24h = null;

    if (change24h !== null) {
        const divisor = 1 + change24h / 100;
        if (divisor > 0) {
            const priceDayAgo = price / divisor;
            high24h = Math.max(price, priceDayAgo);
            low24h = Math.min(price, priceDayAgo);
        }
    }

    return {
        source: MARKET_SOURCES.DEXSCREENER,
        id: pair?.baseToken?.address || null,
        name: pair?.baseToken?.name || 'Unknown Token',
        symbol: String(pair?.baseToken?.symbol || '').toUpperCase(),
        image: pair?.info?.imageUrl || null,
        price,
        change1h: toNumber(pair?.priceChange?.h1),
        change24h,
        change7d: null,
        high24h,
        low24h,
        // Estimated from the 24h move, not reported highs/lows.
        derivedRange: high24h !== null,
        marketCap: toNumber(pair?.marketCap),
        fdv: toNumber(pair?.fdv),
        volume24h: toNumber(pair?.volume?.h24),
        rank: null,
        ath: null,
        athChangePercent: null,
        athDate: null,
        liquidity: toNumber(pair?.liquidity?.usd),
        chain: pair?.chainId || null,
        dex: pair?.dexId || null,
        pairUrl: pair?.url || null,
        sparkline: [],
        lastUpdated: Date.now(),
        fetchedAt: Date.now(),
    };
}

async function fetchFromCoinGecko(coinId) {
    const url = `${COINGECKO_BASE}/coins/markets`
        + `?vs_currency=usd&ids=${encodeURIComponent(coinId)}`
        + '&price_change_percentage=1h%2C24h%2C7d&sparkline=true';

    const data = await fetchJson(url);
    const raw = Array.isArray(data) ? data[0] : null;

    if (!raw) {
        return null;
    }

    return normalizeCoinGecko(raw);
}

async function fetchFromDexScreener(query, { byAddress }) {
    const url = byAddress
        ? `${DEXSCREENER_BASE}/tokens/${encodeURIComponent(query)}`
        : `${DEXSCREENER_BASE}/search?q=${encodeURIComponent(query)}`;

    const data = await fetchJson(url);
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const best = selectBestPair(pairs, { address: byAddress ? query : null });

    if (!best) {
        return null;
    }

    return normalizeDexScreener(best);
}

/**
 * Fetch a normalized market quote for a coin.
 *
 * @param {string} query   Ticker, coin name, or contract address.
 * @param {object} [options]
 * @param {boolean} [options.force] Bypass the short-lived quote cache.
 * @returns {Promise<object|null>} Normalized quote, or null when not found.
 */
export async function getQuote(query, { force = false } = {}) {
    const normalized = normalizeQuery(query);

    if (!normalized) {
        return null;
    }

    const cacheKey = normalized.toLowerCase();

    if (!force) {
        const cached = readCache(quoteCache, cacheKey);
        if (cached) {
            return { ...cached, cached: true };
        }
    }

    const byAddress = isContractAddress(normalized);
    let quote = null;

    if (byAddress) {
        // On-chain address: DexScreener is the only source that will know it.
        quote = await fetchFromDexScreener(normalized, { byAddress: true });
    } else {
        const coinId = await resolveCoinId(normalized).catch((error) => {
            logger.warn('trade: coin id resolution failed', { query: normalized, error: error.message });
            return null;
        });

        if (coinId) {
            quote = await fetchFromCoinGecko(coinId);
        }

        // Not listed on CoinGecko (brand-new memecoin) — try the DEX search.
        if (!quote) {
            quote = await fetchFromDexScreener(normalized, { byAddress: false }).catch((error) => {
                logger.warn('trade: dexscreener fallback failed', { query: normalized, error: error.message });
                return null;
            });
        }
    }

    if (!quote) {
        return null;
    }

    writeCache(quoteCache, cacheKey, quote, MARKET_LIMITS.QUOTE_CACHE_MS);

    return { ...quote, cached: false };
}

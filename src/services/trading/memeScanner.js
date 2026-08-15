// Broad, read-only memecoin market scanner.
//
// The scanner ranks observable market conditions; it does not predict prices or
// recommend trades. CoinGecko's meme-token category is used because it provides
// a consistent, deduplicated universe with price, volume and market-cap data.

import { logger } from '../../utils/logger.js';
import { toNumber } from '../../utils/tradeFormat.js';
import { MarketDataError } from './marketDataService.js';

const COINGECKO_BASE = process.env.COINGECKO_API_BASE || 'https://api.coingecko.com/api/v3';

export const SCANNER_LIMITS = {
    REQUEST_TIMEOUT_MS: 15_000,
    CACHE_MS: 60_000,
    UNIVERSE_SIZE: 250,
    MAX_RESULTS: 10,
};

let scanCache = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numberOrNull = (value) => toNumber(value);

/**
 * Produce an explainable setup score and risk label from market statistics.
 * The score intentionally rewards liquidity/participation as well as momentum,
 * so a tiny token with a single large candle cannot automatically rank first.
 */
export function scoreMemeCoin(coin) {
    const change1h = numberOrNull(coin.change1h);
    const change24h = numberOrNull(coin.change24h);
    const change7d = numberOrNull(coin.change7d);
    const marketCap = numberOrNull(coin.marketCap);
    const volume24h = numberOrNull(coin.volume24h);
    const volumeRatio = marketCap > 0 && volume24h !== null ? volume24h / marketCap : null;

    let score = 50;
    const reasons = [];
    const warnings = [];

    if (change1h !== null) score += clamp(change1h, -10, 10) * 0.8;
    if (change24h !== null) score += clamp(change24h, -30, 40) * 0.55;
    if (change7d !== null) score += clamp(change7d, -50, 80) * 0.12;

    if (change1h > 0 && change24h > 0) reasons.push('1h and 24h momentum agree');
    if (change24h > 5 && change7d > 0) reasons.push('positive 24h and 7d trend');

    if (volumeRatio !== null) {
        if (volumeRatio >= 0.08 && volumeRatio <= 1.25) {
            score += 12;
            reasons.push('strong trading activity');
        } else if (volumeRatio < 0.02) {
            score -= 14;
            warnings.push('low volume versus market cap');
        } else if (volumeRatio > 2.5) {
            score -= 7;
            warnings.push('extreme turnover may be unstable');
        }
    }

    if (marketCap !== null) {
        if (marketCap >= 100_000_000) score += 7;
        else if (marketCap < 1_000_000) {
            score -= 18;
            warnings.push('micro-cap');
        } else if (marketCap < 10_000_000) {
            score -= 7;
            warnings.push('small-cap volatility');
        }
    }

    if (volume24h !== null && volume24h < 100_000) {
        score -= 12;
        warnings.push('thin daily volume');
    }

    if (change1h !== null && Math.abs(change1h) >= 20) {
        score -= 10;
        warnings.push('extreme 1h move');
    }
    if (change24h !== null && Math.abs(change24h) >= 80) {
        score -= 10;
        warnings.push('extreme 24h volatility');
    }
    if (change24h > 35) warnings.push('already extended today');

    const missing = [change1h, change24h, change7d, marketCap, volume24h]
        .filter((value) => value === null).length;
    score -= missing * 4;
    if (missing >= 2) warnings.push('incomplete market data');

    const finalScore = Math.round(clamp(score, 0, 100));
    const risk = warnings.some((warning) => /micro-cap|thin|extreme|incomplete/.test(warning))
        ? 'Very high'
        : marketCap !== null && marketCap >= 100_000_000 && volumeRatio >= 0.05
            ? 'High'
            : 'High+';

    return {
        score: finalScore,
        risk,
        volumeRatio,
        reasons: reasons.slice(0, 2),
        warnings: [...new Set(warnings)].slice(0, 3),
    };
}

function normalizeCoin(raw) {
    const price = numberOrNull(raw?.current_price);
    if (price === null) return null;

    const coin = {
        id: String(raw?.id || ''),
        name: String(raw?.name || raw?.id || 'Unknown'),
        symbol: String(raw?.symbol || '?').toUpperCase(),
        image: raw?.image || null,
        price,
        marketCap: numberOrNull(raw?.market_cap),
        volume24h: numberOrNull(raw?.total_volume),
        change1h: numberOrNull(raw?.price_change_percentage_1h_in_currency),
        change24h: numberOrNull(raw?.price_change_percentage_24h_in_currency)
            ?? numberOrNull(raw?.price_change_percentage_24h),
        change7d: numberOrNull(raw?.price_change_percentage_7d_in_currency),
        rank: numberOrNull(raw?.market_cap_rank),
        athChangePercent: numberOrNull(raw?.ath_change_percentage),
        url: raw?.id ? `https://www.coingecko.com/en/coins/${raw.id}` : null,
    };

    return { ...coin, ...scoreMemeCoin(coin) };
}

async function requestUniverse({ transport = globalThis.fetch, timeoutMs = SCANNER_LIMITS.REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=meme-token`
        + `&order=volume_desc&per_page=${SCANNER_LIMITS.UNIVERSE_SIZE}&page=1`
        + '&sparkline=false&price_change_percentage=1h%2C24h%2C7d';

    try {
        const response = await transport(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json', 'User-Agent': 'TitanBot/2.1 (+meme-scanner)' },
        });
        if (response?.status === 429) {
            throw new MarketDataError('The market scanner is being rate limited. Try again in a minute.', {
                code: 'rate_limited', retryable: true,
            });
        }
        if (!response?.ok) {
            throw new MarketDataError(`Market scanner returned HTTP ${response?.status || 'unknown'}.`, {
                code: 'upstream_error', retryable: true,
            });
        }
        const body = await response.json();
        if (!Array.isArray(body)) throw new Error('Unexpected scanner payload');
        return body;
    } catch (error) {
        if (error instanceof MarketDataError) throw error;
        const timedOut = error?.name === 'AbortError';
        throw new MarketDataError(
            timedOut ? 'The market scan timed out.' : 'Could not reach the market scanner.',
            { code: timedOut ? 'timeout' : 'network_error', retryable: true },
        );
    } finally {
        clearTimeout(timer);
    }
}

/** Scan and rank the current memecoin universe. */
export async function scanMemeMarket({ force = false, transport = globalThis.fetch, now = Date.now() } = {}) {
    if (!force && scanCache?.expiresAt > now) return scanCache.value;

    const raw = await requestUniverse({ transport });
    const coins = raw.map(normalizeCoin).filter(Boolean);

    // Remove obvious dead markets from the ranked list, but preserve the full
    // scanned count so users understand the coverage.
    const active = coins.filter((coin) => (
        (coin.marketCap ?? 0) >= 250_000
        && (coin.volume24h ?? 0) >= 25_000
        && coin.change24h !== null
    ));

    const setups = [...active]
        .filter((coin) => coin.change24h > -20)
        .sort((a, b) => (b.score - a.score) || ((b.volume24h ?? 0) - (a.volume24h ?? 0)))
        .slice(0, SCANNER_LIMITS.MAX_RESULTS);

    const movers = [...active]
        .filter((coin) => coin.change24h > 0)
        .sort((a, b) => b.change24h - a.change24h)
        .slice(0, SCANNER_LIMITS.MAX_RESULTS);

    const result = {
        scanned: coins.length,
        active: active.length,
        setups,
        movers,
        generatedAt: now,
        source: 'CoinGecko meme-token category',
        methodology: 'Momentum + market depth + trading activity − volatility and data-quality penalties',
    };

    scanCache = { value: result, expiresAt: now + SCANNER_LIMITS.CACHE_MS };
    logger.info('trade: memecoin scan completed', { scanned: coins.length, active: active.length });
    return result;
}

export function clearScannerCache() {
    scanCache = null;
}

export const __testables = { normalizeCoin };

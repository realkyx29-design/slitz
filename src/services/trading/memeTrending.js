// memeTrending.js — freshly-boosted, on-chain memecoins for /trade trending.
//
// The market scanner covers CoinGecko's listed meme universe; this service
// covers the other end: brand-new tokens buying visibility via DexScreener
// boosts, most of which are not listed anywhere yet. These are the highest
// risk names in crypto, so every result carries a liquidity floor and an
// explicit risk label, and nothing here ever executes a trade.

import { logger } from '../../utils/logger.js';
import { toNumber } from '../../utils/tradeFormat.js';
import { fetchTopBoostedTokens, getQuote, MarketDataError } from './marketDataService.js';
import { scoreMemeCoin } from './memeScanner.js';

export const TRENDING_LIMITS = {
    CACHE_MS: 60_000,
    /** Cap on how many boosted tokens we hydrate with a quote lookup. */
    MAX_TOKENS: 8,
    /** Results below this liquidity are dropped — dust pools misprice badly. */
    MIN_LIQUIDITY_USD: 5_000,
    MAX_RESULTS: 6,
};

let trendingCache = null;

export function clearTrendingCache() {
    trendingCache = null;
}

/** Deduplicate boosts by chain+address, keeping the largest boost. */
export function dedupeBoosts(boosts) {
    const byKey = new Map();

    for (const boost of boosts || []) {
        const key = `${boost.chainId}:${boost.tokenAddress.toLowerCase()}`;
        const existing = byKey.get(key);

        if (!existing || (boost.totalAmount || 0) > (existing.totalAmount || 0)) {
            byKey.set(key, boost);
        }
    }

    return [...byKey.values()];
}

/** DexScreener chain ids are lowercase slugs (solana, ethereum, base, ...). */
function chainLabel(chainId) {
    const label = String(chainId || '').trim();
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : null;
}

/**
 * Hydrate boosted tokens into display-ready trending entries.
 * Quote lookups run in parallel and are tolerant of individual failures —
 * a dead token simply drops out rather than failing the whole board.
 */
export async function getTrendingTokens({ force = false, now = Date.now() } = {}) {
    if (!force && trendingCache?.expiresAt > now) {
        return trendingCache.value;
    }

    const boosts = dedupeBoosts(await fetchTopBoostedTokens())
        .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0))
        .slice(0, TRENDING_LIMITS.MAX_TOKENS);

    if (boosts.length === 0) {
        throw new MarketDataError('No boosted tokens are being advertised right now.', {
            code: 'empty_universe',
            retryable: true,
        });
    }

    const settled = await Promise.allSettled(boosts.map(async (boost) => {
        const quote = await getQuote(boost.tokenAddress, { force: true });

        if (!quote) {
            return null;
        }

        const liquidity = toNumber(quote.liquidity);
        if (liquidity !== null && liquidity < TRENDING_LIMITS.MIN_LIQUIDITY_USD) {
            return null;
        }

        // Reuse the scanner's explainable risk scoring for consistency.
        const { score, risk, warnings } = scoreMemeCoin({
            change1h: quote.change1h,
            change24h: quote.change24h,
            change7d: quote.change7d,
            marketCap: quote.marketCap,
            volume24h: quote.volume24h,
        });

        return {
            quote,
            boost,
            score,
            risk,
            warnings,
            chain: chainLabel(boost.chainId),
            url: quote.pairUrl || `https://dexscreener.com/${boost.chainId}/${boost.tokenAddress}`,
        };
    }));

    const entries = settled
        .filter((result) => result.status === 'fulfilled' && result.value)
        .map((result) => result.value)
        .sort((a, b) => ((b.quote.change24h ?? -Infinity) - (a.quote.change24h ?? -Infinity)))
        .slice(0, TRENDING_LIMITS.MAX_RESULTS);

    const value = {
        entries,
        scanned: boosts.length,
        generatedAt: now,
        source: 'DexScreener top boosts',
    };

    trendingCache = { value, expiresAt: now + TRENDING_LIMITS.CACHE_MS };

    logger.info('trade: trending board built', { scanned: boosts.length, listed: entries.length });

    return value;
}

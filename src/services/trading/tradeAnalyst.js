// tradeAnalyst.js — optional AI commentary for the /trade card.
//
// SAFETY CONTRACT (do not weaken):
//   • The model receives numbers and returns prose. Nothing else.
//   • It is given no tools, no functions, and no execution surface.
//   • It cannot buy, sell, transfer, or custody anything — this module has no
//     code path to any wallet, exchange, or economy balance.
//   • Output is length-clamped, stripped of links/mentions, and rendered inside
//     an embed with mentions disabled.
//
// Reuses the provider plumbing already configured for the ticket assistant, so
// operators configure one API key rather than two.

import {
    normalizeAiConfig,
    requestAiCompletion,
} from '../ticketAI/aiSupportService.js';
import { logger } from '../../utils/logger.js';
import {
    formatCompact,
    formatPercent,
    formatPrice,
    formatSignedMoney,
    toNumber,
} from '../../utils/tradeFormat.js';

export const ANALYST_LIMITS = {
    MAX_CHARS: 600,
    TIMEOUT_MS: 15_000,
    CACHE_MS: 60_000,
};

const SYSTEM_PROMPT = [
    'You are a market data analyst inside a Discord bot. You explain crypto and',
    'memecoin market statistics in plain language.',
    '',
    'Absolute rules:',
    '- You CANNOT execute trades, place orders, move funds, or access wallets.',
    '  You have no such ability. Never imply you do or offer to do so.',
    '- Never tell the user to buy, sell, or hold. No price targets, no',
    '  predictions, no "this will pump/dump".',
    '- Describe only what the provided numbers show: momentum, volatility,',
    '  liquidity depth, volume relative to market cap, distance from ATH, and',
    '  the risk those imply.',
    '- Memecoins are extremely high risk. Where the data shows thin liquidity,',
    '  extreme drawdown, or a volume/market-cap imbalance, say so plainly.',
    '- 3 short sentences maximum, under 500 characters. No markdown headers,',
    '  no bullet lists, no links, no @mentions.',
].join('\n');

/**
 * Last line of defence for the read-only guarantee.
 *
 * The system prompt already forbids it, but a jailbroken or confused model
 * could still emit text claiming it placed an order or moved money. Nothing in
 * this codebase can actually do that, so such a claim is always false — and a
 * false claim about someone's money is the worst possible output. If any of
 * these match we discard the whole analysis rather than trying to patch it.
 */
const EXECUTION_CLAIM_PATTERNS = [
    /\bi\s+(?:have\s+|just\s+|already\s+)?(?:bought|sold|purchased|swapped|traded|invested|transferred|sent|withdrawn|deposited)\b/i,
    /\bi(?:'m|\s+am|\s+will|\s+can|\s+could)\s+(?:now\s+)?(?:buy|sell|purchas|swap|trad|transfer|send|execut|plac|submit|fill)/i,
    /\b(?:executing|placing|submitting|filling|processing|initiating)\s+(?:your|the|a|an)\s+(?:buy|sell|order|trade|swap|transaction|position)/i,
    /\b(?:transferring|moving|sending|withdrawing|depositing)\s+(?:your\s+)?(?:funds|money|tokens|coins|balance)/i,
    /\b(?:order|trade|swap|transaction)\s+(?:has been\s+|was\s+)?(?:placed|executed|filled|completed|confirmed)\b/i,
    /\baccess(?:ing)?\s+your\s+wallet\b/i,
];

const analysisCache = new Map();

function cacheKey(quote) {
    // Bucket by 30s so rapid refreshes reuse one analysis.
    return `${quote.source}:${quote.id}:${Math.floor(Date.now() / 30_000)}`;
}

/** True when an AI provider is configured and trade analysis is switched on. */
export function isAnalystEnabled(env = process.env) {
    if (String(env.TRADE_AI_ENABLED || '').toLowerCase() === 'false') {
        return false;
    }

    const config = normalizeAiConfig(env);
    return Boolean(config.apiKey);
}

/** Strip anything that could ping, link out, or break the embed. */
export function sanitizeAnalysis(text, { maxChars = ANALYST_LIMITS.MAX_CHARS } = {}) {
    if (typeof text !== 'string') {
        return null;
    }

    let clean = text
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/<@!?\d+>/g, '')
        .replace(/<@&\d+>/g, '')
        .replace(/@(everyone|here)/gi, 'everyone')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/```/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean) {
        return null;
    }

    // Reject outright rather than sanitize: a model that claims it acted on
    // funds is malfunctioning, and no part of that response can be trusted.
    for (const pattern of EXECUTION_CLAIM_PATTERNS) {
        if (pattern.test(clean)) {
            logger.error('trade: AI analysis claimed to perform a transaction — discarded', {
                excerpt: clean.slice(0, 120),
            });
            return null;
        }
    }

    if (clean.length > maxChars) {
        clean = clean.slice(0, maxChars);
        // Trim back to the last sentence boundary so it does not end mid-word.
        const lastStop = Math.max(clean.lastIndexOf('. '), clean.lastIndexOf('! '), clean.lastIndexOf('? '));
        if (lastStop > maxChars * 0.5) {
            clean = clean.slice(0, lastStop + 1);
        } else {
            clean = `${clean.trimEnd()}…`;
        }
    }

    return clean;
}

/** Turn a quote (+ optional position) into a compact numeric brief. */
export function buildAnalysisPrompt(quote, position = null) {
    const lines = [
        `Coin: ${quote.name} (${quote.symbol})`,
        `Price: ${formatPrice(quote.price)}`,
    ];

    const add = (label, value) => {
        if (value !== null && value !== undefined && value !== '—') {
            lines.push(`${label}: ${value}`);
        }
    };

    add('1h change', toNumber(quote.change1h) === null ? null : formatPercent(quote.change1h));
    add('24h change', toNumber(quote.change24h) === null ? null : formatPercent(quote.change24h));
    add('7d change', toNumber(quote.change7d) === null ? null : formatPercent(quote.change7d));
    add('24h high', toNumber(quote.high24h) === null ? null : formatPrice(quote.high24h));
    add('24h low', toNumber(quote.low24h) === null ? null : formatPrice(quote.low24h));
    add('Market cap', toNumber(quote.marketCap) === null ? null : formatCompact(quote.marketCap));
    add('24h volume', toNumber(quote.volume24h) === null ? null : formatCompact(quote.volume24h));
    add('Liquidity', toNumber(quote.liquidity) === null ? null : formatCompact(quote.liquidity));
    add('Market cap rank', toNumber(quote.rank) === null ? null : `#${quote.rank}`);
    add('From all-time high', toNumber(quote.athChangePercent) === null
        ? null
        : formatPercent(quote.athChangePercent, { decimals: 1 }));
    add('Chain', quote.chain || null);

    if (position) {
        lines.push(
            `User's hypothetical position: ${formatPrice(position.amount)} invested at `
            + `${formatPrice(position.entryPrice)}, now worth ${formatPrice(position.currentValue)} `
            + `(${formatSignedMoney(position.profitLoss)}, ${formatPercent(position.profitLossPercent)}).`,
        );
    }

    lines.push('', 'Summarise what these numbers show. No advice, no predictions.');

    return lines.join('\n');
}

/**
 * Request a short read on the market data.
 * Always resolves — a failed or disabled analyst simply yields null.
 */
export async function analyzeMarket(quote, position = null, { env = process.env, transport = null } = {}) {
    if (!quote || !isAnalystEnabled(env)) {
        return null;
    }

    const key = cacheKey(quote);
    const cached = analysisCache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    try {
        const config = {
            ...normalizeAiConfig(env),
            timeoutMs: ANALYST_LIMITS.TIMEOUT_MS,
        };

        const { text, error } = await requestAiCompletion({
            config,
            transport,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildAnalysisPrompt(quote, position) },
            ],
        });

        if (error || !text) {
            logger.warn('trade: AI analysis unavailable', { reason: error?.message || 'empty response' });
            return null;
        }

        const analysis = sanitizeAnalysis(text);

        if (analysis) {
            analysisCache.set(key, { value: analysis, expiresAt: Date.now() + ANALYST_LIMITS.CACHE_MS });

            if (analysisCache.size > 200) {
                const now = Date.now();
                for (const [entryKey, entry] of analysisCache) {
                    if (entry.expiresAt <= now) {
                        analysisCache.delete(entryKey);
                    }
                }
            }
        }

        return analysis;
    } catch (error) {
        logger.warn('trade: AI analysis threw', { error: error.message });
        return null;
    }
}

export function clearAnalysisCache() {
    analysisCache.clear();
}

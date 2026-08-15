// signalEngine.js — momentum signals for the /trade signals subcommand.
//
// Picks coins whose observable momentum points up, sizes a HYPOTHETICAL stake
// against a budget, and projects what that stake would be worth under a few
// clearly labelled scenarios.
//
// READ-ONLY BY DESIGN: everything here is arithmetic on public market data.
// The bot has no wallet, no exchange keys and no execution path, so a "signal"
// can never become an order. Output is framed accordingly.

import { toNumber } from '../../utils/tradeFormat.js';

export const SIGNAL_LIMITS = {
    DEFAULT_BUDGET: 100,
    MIN_BUDGET: 5,
    MAX_BUDGET: 1_000_000,
    /** Minimum setup score a coin needs to become a signal candidate. */
    MIN_SCORE: 55,
    /** Do not chase candles: coins already up more than this are skipped. */
    MAX_24H_EXTENDED_PERCENT: 150,
    MAX_CANDIDATES: 3,
    MAX_SCENARIO_ROWS: 4,
};

/** Standard multiplier ladder for the standalone simulator. */
export const SIMULATION_LADDER = [1.25, 1.5, 2, 3, 5, 10];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Resolve the hypothetical budget from env, clamped to a sane range. */
export function resolveSignalBudget(env = process.env) {
    const raw = toNumber(env.TRADE_SIGNAL_BUDGET);

    if (raw === null) {
        return SIGNAL_LIMITS.DEFAULT_BUDGET;
    }

    return clamp(raw, SIGNAL_LIMITS.MIN_BUDGET, SIGNAL_LIMITS.MAX_BUDGET);
}

/**
 * A coin is "heading up" when short and medium momentum agree.
 * Missing 1h data is tolerated (some sources omit it); missing 24h is not.
 */
export function isHeadingUp(coin) {
    const change24h = toNumber(coin?.change24h);

    if (change24h === null || change24h <= 0) {
        return false;
    }

    const change1h = toNumber(coin?.change1h);

    return change1h === null || change1h >= 0;
}

/**
 * Pick signal candidates from a completed market scan.
 *
 * Rules: momentum must point up, the setup score must clear a quality bar,
 * and already-vertical candles are excluded so the signal does not point at
 * the top of a move that already happened.
 */
export function selectSignalCandidates(scan, { now = Date.now() } = {}) {
    const pool = new Map();

    for (const coin of [...(scan?.setups || []), ...(scan?.movers || [])]) {
        if (coin?.id && !pool.has(coin.id)) {
            pool.set(coin.id, coin);
        }
    }

    const candidates = [...pool.values()].filter((coin) => {
        if (!isHeadingUp(coin)) return false;

        const score = toNumber(coin.score);
        if (score === null || score < SIGNAL_LIMITS.MIN_SCORE) return false;

        const change24h = toNumber(coin.change24h);
        if (change24h === null || change24h > SIGNAL_LIMITS.MAX_24H_EXTENDED_PERCENT) return false;

        return true;
    });

    candidates.sort(
        (a, b) => (b.score - a.score) || ((b.change24h ?? 0) - (a.change24h ?? 0)),
    );

    return candidates.slice(0, SIGNAL_LIMITS.MAX_CANDIDATES).map((coin) => ({ ...coin, spottedAt: now }));
}

/**
 * Risk-adjusted hypothetical stake sizing.
 *
 * The deeper and more liquid the market, the larger the slice of the budget it
 * is modelled with. Flags from the scanner (thin volume, extreme moves, ...)
 * halve the size, because that is what a cautious researcher would do.
 *
 * @returns {{ amount: number, multiplier: number, reason: string }}
 */
export function suggestStake(coin, budget) {
    const budgetValue = clamp(
        toNumber(budget) ?? SIGNAL_LIMITS.DEFAULT_BUDGET,
        SIGNAL_LIMITS.MIN_BUDGET,
        SIGNAL_LIMITS.MAX_BUDGET,
    );

    const marketCap = toNumber(coin?.marketCap);
    let tier;
    let label;

    if (marketCap === null) {
        tier = 0.25;
        label = 'unknown market cap';
    } else if (marketCap >= 500_000_000) {
        tier = 1.0;
        label = 'deeply liquid market';
    } else if (marketCap >= 50_000_000) {
        tier = 0.75;
        label = 'established mid-cap';
    } else if (marketCap >= 10_000_000) {
        tier = 0.5;
        label = 'small-cap';
    } else if (marketCap >= 1_000_000) {
        tier = 0.3;
        label = 'micro-cap';
    } else {
        tier = 0.15;
        label = 'ultra micro-cap';
    }

    const warnings = Array.isArray(coin?.warnings) ? coin.warnings : [];
    const flagged = warnings.length > 0;
    const multiplier = tier * (flagged ? 0.5 : 1);

    let amount = budgetValue * multiplier;

    // Round to clean, human-sized numbers.
    if (amount >= 100) amount = Math.round(amount / 10) * 10;
    else if (amount >= 20) amount = Math.round(amount / 5) * 5;
    else amount = Math.max(1, Math.round(amount));

    amount = clamp(amount, 1, budgetValue);

    const reason = flagged
        ? `${label}; size halved (${warnings.length} scanner flag${warnings.length > 1 ? 's' : ''})`
        : label;

    return { amount, multiplier, reason };
}

/**
 * Project what a stake would be worth under a few labelled scenarios.
 * Pure math — every value is exactly stake * multiplier.
 */
export function projectScenarios(stakeAmount, multipliers) {
    const stake = toNumber(stakeAmount);

    if (stake === null || stake <= 0) {
        return [];
    }

    return multipliers
        .map(toNumber)
        .filter((multiplier) => multiplier !== null && multiplier > 0)
        .map((multiplier) => {
            const value = stake * multiplier;
            return {
                multiplier,
                value,
                profit: value - stake,
            };
        });
}

/**
 * Scenario set for a signal: today's pace (when positive), +50%, 2x, an ATH
 * retest when that is a realistic multiple, and 5x. Near-duplicate
 * multipliers are merged so the table stays readable.
 */
export function buildSignalScenarios(coin, stakeAmount, { maxRows = SIGNAL_LIMITS.MAX_SCENARIO_ROWS } = {}) {
    const stake = toNumber(stakeAmount);
    const change24h = toNumber(coin?.change24h);
    const price = toNumber(coin?.price);
    const ath = toNumber(coin?.ath);

    if (stake === null || stake <= 0) {
        return [];
    }

    const rows = [];

    if (change24h !== null && change24h > 0) {
        rows.push({ label: 'Repeats today', multiplier: 1 + change24h / 100 });
    }

    rows.push({ label: '+50%', multiplier: 1.5 });
    rows.push({ label: '2x', multiplier: 2 });

    if (ath !== null && price !== null && price > 0 && ath > price) {
        const multiple = ath / price;
        if (multiple > 1.05 && multiple <= 25) {
            rows.push({ label: 'Retests ATH', multiplier: multiple });
        }
    }

    rows.push({ label: '5x', multiplier: 5 });

    // Merge near-duplicate multipliers (keep the first, more descriptive label).
    const deduped = [];
    for (const row of rows) {
        const twin = deduped.find(
            (kept) => Math.abs(kept.multiplier - row.multiplier) / kept.multiplier < 0.08,
        );
        if (!twin) {
            deduped.push(row);
        }
    }

    deduped.sort((a, b) => a.multiplier - b.multiplier);
    const chosen = deduped.slice(0, maxRows);

    return chosen.map((row) => {
        const value = stake * row.multiplier;
        return {
            label: row.label,
            multiplier: row.multiplier,
            value,
            profit: value - stake,
        };
    });
}

/**
 * Build the complete signal from a scan result.
 *
 * @returns {null|{
 *   primary: object, candidates: object[], stake: object,
 *   scenarios: object[], budget: number, generatedAt: number, source: string
 * }}
 */
export function buildSignal({ scan, budget, now = Date.now() } = {}) {
    const candidates = selectSignalCandidates(scan, { now });

    if (candidates.length === 0) {
        return null;
    }

    const [primary, ...rest] = candidates;
    const budgetValue = clamp(
        toNumber(budget) ?? SIGNAL_LIMITS.DEFAULT_BUDGET,
        SIGNAL_LIMITS.MIN_BUDGET,
        SIGNAL_LIMITS.MAX_BUDGET,
    );

    const stake = suggestStake(primary, budgetValue);
    const scenarios = buildSignalScenarios(primary, stake.amount);

    return {
        primary,
        candidates: rest,
        stake,
        scenarios,
        budget: budgetValue,
        generatedAt: now,
        source: scan?.source || 'market scan',
    };
}

/**
 * Scenario table for the standalone simulator: the standard ladder plus an
 * ATH retest row when the coin is meaningfully below its all-time high.
 */
export function buildSimulationScenarios(quote, amount) {
    const price = toNumber(quote?.price);
    const ath = toNumber(quote?.ath);

    const multipliers = [...SIMULATION_LADDER];
    const labels = SIMULATION_LADDER.map((multiplier) => `${multiplier}x`);

    if (ath !== null && price !== null && price > 0 && ath > price) {
        const multiple = ath / price;
        if (multiple > 1.05 && multiple <= 100) {
            multipliers.push(multiple);
            labels.push('Retests ATH');
        }
    }

    const order = multipliers
        .map((multiplier, index) => ({ multiplier, label: labels[index] }))
        .sort((a, b) => a.multiplier - b.multiplier);

    return projectScenarios(amount, order.map((row) => row.multiplier))
        .map((scenario, index) => ({ label: order[index].label, ...scenario }));
}

export const __testables = { clamp };

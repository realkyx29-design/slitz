// positionCalculator.js — pure profit/loss math for the /trade command.
//
// READ-ONLY BY DESIGN: this module models what an investment *would* be worth.
// It never touches balances, never records ownership, and nothing in the
// codebase may use it to move real or in-bot funds.

import { toNumber } from '../../utils/tradeFormat.js';

/** Hard bounds keep the math (and the embed) sane. */
export const POSITION_LIMITS = {
    MIN_AMOUNT: 0.01,
    MAX_AMOUNT: 1_000_000_000_000, // $1T notional ceiling
};

/**
 * Validate a hypothetical position.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validatePosition({ amount, entryPrice }) {
    const amountValue = toNumber(amount);
    const entryValue = toNumber(entryPrice);

    if (amountValue === null || amountValue <= 0) {
        return { ok: false, reason: 'The invested amount must be a positive number.' };
    }

    if (amountValue < POSITION_LIMITS.MIN_AMOUNT) {
        return { ok: false, reason: `The invested amount must be at least $${POSITION_LIMITS.MIN_AMOUNT}.` };
    }

    if (amountValue > POSITION_LIMITS.MAX_AMOUNT) {
        return { ok: false, reason: 'That invested amount is unrealistically large.' };
    }

    if (entryValue === null || entryValue <= 0) {
        return { ok: false, reason: 'The entry price must be a positive number.' };
    }

    return { ok: true };
}

/**
 * Calculate the current value and unrealised P/L of a hypothetical position.
 *
 * @param {object} input
 * @param {number} input.amount       USD put in at the entry price.
 * @param {number} input.entryPrice   Price per token when the position opened.
 * @param {number} input.currentPrice Latest price per token.
 * @returns {null|{
 *   amount: number, entryPrice: number, currentPrice: number, units: number,
 *   currentValue: number, profitLoss: number, profitLossPercent: number,
 *   direction: 'up'|'down'|'flat', isProfit: boolean, breakEven: boolean,
 *   multiple: number
 * }}
 */
export function calculatePosition({ amount, entryPrice, currentPrice }) {
    const amountValue = toNumber(amount);
    const entryValue = toNumber(entryPrice);
    const currentValue = toNumber(currentPrice);

    if (amountValue === null || entryValue === null || currentValue === null) {
        return null;
    }

    if (amountValue <= 0 || entryValue <= 0 || currentValue < 0) {
        return null;
    }

    const units = amountValue / entryValue;
    const positionValue = units * currentValue;
    const profitLoss = positionValue - amountValue;

    // Percentage change is derived from price alone, so it stays exact even when
    // the notional amount is tiny (avoids amplifying float error).
    const profitLossPercent = ((currentValue - entryValue) / entryValue) * 100;

    // Treat sub-cent noise on the P/L as break-even for display purposes.
    const breakEven = Math.abs(profitLoss) < 0.005;
    const direction = breakEven ? 'flat' : profitLoss > 0 ? 'up' : 'down';

    return {
        amount: amountValue,
        entryPrice: entryValue,
        currentPrice: currentValue,
        units,
        currentValue: positionValue,
        profitLoss,
        profitLossPercent,
        direction,
        isProfit: profitLoss > 0,
        breakEven,
        multiple: currentValue / entryValue,
    };
}

/**
 * "What if you had bought 24h ago" — uses the 24h percentage change to derive
 * the price a day ago, then runs the same math.
 */
export function calculateTwentyFourHourWhatIf({ amount, currentPrice, changePercent24h }) {
    const amountValue = toNumber(amount);
    const currentValue = toNumber(currentPrice);
    const change = toNumber(changePercent24h);

    if (amountValue === null || currentValue === null || change === null) {
        return null;
    }

    const divisor = 1 + change / 100;

    // A -100% (or worse) move would make the implied price zero/negative.
    if (divisor <= 0) {
        return null;
    }

    const priceDayAgo = currentValue / divisor;

    return calculatePosition({
        amount: amountValue,
        entryPrice: priceDayAgo,
        currentPrice: currentValue,
    });
}

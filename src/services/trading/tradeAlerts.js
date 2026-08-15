// tradeAlerts.js — one-shot price alerts for the /trade watch subcommand.
//
// A user pins a coin to a target ("ping me when PEPE crosses $0.00001"). A
// shared poller re-quotes every pinned coin on an interval and, when a target
// is crossed, pings the owner in the channel they set it from. Alerts are
// single-shot: they fire once and are removed.
//
// In-memory and self-cleaning like the live trackers: the loop stops on
// shutdown, and an alert that keeps failing to resolve is retired so the bot
// never spins on a dead ticker.
//
// READ-ONLY: alerts read public prices and post a Discord message. Nothing
// here can trade or move funds.

import crypto from 'node:crypto';

import { logger } from '../../utils/logger.js';
import { getQuote } from './marketDataService.js';
import { arrowFor, formatPercent, formatPrice } from '../../utils/tradeFormat.js';

export const ALERT_LIMITS = {
    POLL_MS: 45_000,
    MAX_PER_USER: 6,
    MAX_TOTAL: 60,
    MAX_CONSECUTIVE_ERRORS: 6,
    // Treat crossing within this relative band as "hit", absorbing price jitter.
    HIT_TOLERANCE: 0.0005,
};

/** alertId -> alert */
const alerts = new Map();

/** The Discord client used to deliver triggers. Set via startAlertLoop. */
let alertClient = null;
let loopTimer = null;

export function getAlertCount() {
    return alerts.size;
}

export function getAlertsForUser(userId) {
    return [...alerts.values()].filter((alert) => alert.userId === userId);
}

export function getAlert(alertId) {
    return alerts.get(alertId) || null;
}

function countUserAlerts(userId) {
    return getAlertsForUser(userId).length;
}

/**
 * Register a one-shot price alert.
 *
 * @returns {{ ok: boolean, reason?: string, alert?: object }}
 */
export function addAlert({
    userId,
    channelId,
    guildId,
    query,
    symbol,
    targetPrice,
    direction,
    basePrice = null,
}) {
    if (!userId || !channelId || !query || !targetPrice || !direction) {
        return { ok: false, reason: 'An alert needs a coin, a target price, and a direction.' };
    }

    if (direction !== 'above' && direction !== 'below') {
        return { ok: false, reason: 'Direction must be "above" or "below".' };
    }

    if (countUserAlerts(userId) >= ALERT_LIMITS.MAX_PER_USER) {
        return {
            ok: false,
            reason: `You already have ${ALERT_LIMITS.MAX_PER_USER} alerts. Remove one with \`/trade watch remove\` first.`,
        };
    }

    if (alerts.size >= ALERT_LIMITS.MAX_TOTAL) {
        return { ok: false, reason: 'The bot is tracking the maximum number of alerts right now. Try again shortly.' };
    }

    // One alert per coin+direction per user: re-adding replaces the target.
    const existing = getAlertsForUser(userId).find(
        (alert) => alert.query.toLowerCase() === String(query).toLowerCase()
            && alert.direction === direction,
    );

    if (existing) {
        existing.targetPrice = targetPrice;
        existing.basePrice = basePrice ?? existing.basePrice;
        existing.createdAt = Date.now();
        return { ok: true, alert: existing, replaced: true };
    }

    const alertId = crypto.randomBytes(8).toString('hex');
    const alert = {
        id: alertId,
        userId,
        channelId,
        guildId: guildId || null,
        query: String(query),
        symbol: String(symbol || query).toUpperCase(),
        targetPrice,
        direction,
        basePrice,
        createdAt: Date.now(),
        errorCount: 0,
    };

    alerts.set(alertId, alert);

    logger.info('trade: price alert added', {
        alertId,
        coin: alert.symbol,
        direction,
        targetPrice,
        userId,
    });

    return { ok: true, alert };
}

/** Remove every alert a user has on a coin (any direction). */
export function removeAlerts(userId, query) {
    const normalized = String(query || '').toLowerCase();
    let removed = 0;

    for (const [alertId, alert] of alerts) {
        if (alert.userId === userId && alert.query.toLowerCase() === normalized) {
            alerts.delete(alertId);
            removed += 1;
        }
    }

    return { ok: removed > 0, removed };
}

function isHit(alert, price) {
    const band = alert.targetPrice * ALERT_LIMITS.HIT_TOLERANCE;

    if (alert.direction === 'above') {
        return price >= alert.targetPrice - band;
    }

    return price <= alert.targetPrice + band;
}

async function deliver(alert, quote, client) {
    if (!client) {
        return false;
    }

    try {
        const channel = await client.channels.fetch(alert.channelId).catch(() => null);

        if (!channel || typeof channel.send !== 'function') {
            return false;
        }

        const arrow = arrowFor(alert.direction === 'above' ? 1 : -1);
        const move = alert.basePrice
            ? ((quote.price - alert.basePrice) / alert.basePrice) * 100
            : null;

        const lines = [
            `<@${alert.userId}> ${alert.symbol} crossed your ${alert.direction} target.`,
            `Target ${formatPrice(alert.targetPrice)} ${arrow} now **${formatPrice(quote.price)}**`
            + (move === null ? '' : ` (${formatPercent(move)} since you set it).`),
            '*Read-only price alert — this bot never trades or moves funds.*',
        ];

        await channel.send({
            content: lines.join('\n').slice(0, 2000),
            allowedMentions: { users: [alert.userId], parse: [] },
        });

        return true;
    } catch (error) {
        logger.warn('trade: alert delivery failed', { alertId: alert.id, error: error.message });
        return false;
    }
}

/**
 * Check every alert once against a fresh quote. Exported for tests, which may
 * inject a client override.
 */
export async function checkAlerts({ client = alertClient } = {}) {
    const snapshot = [...alerts.values()];
    const fired = [];

    for (const alert of snapshot) {
        if (!alerts.has(alert.id)) {
            continue; // Removed mid-sweep by an earlier trigger/replacement.
        }

        let quote = null;

        try {
            quote = await getQuote(alert.query, { force: true });
        } catch (error) {
            logger.debug('trade: alert quote failed', { alertId: alert.id, error: error.message });
        }

        if (!quote || typeof quote.price !== 'number') {
            alert.errorCount += 1;

            if (alert.errorCount >= ALERT_LIMITS.MAX_CONSECUTIVE_ERRORS) {
                alerts.delete(alert.id);
                logger.info('trade: alert retired after repeated failures', {
                    alertId: alert.id,
                    coin: alert.symbol,
                });
            }

            continue;
        }

        alert.errorCount = 0;

        if (isHit(alert, quote.price)) {
            alerts.delete(alert.id);
            await deliver(alert, quote, client);
            fired.push({ alert, price: quote.price });

            logger.info('trade: price alert triggered', {
                alertId: alert.id,
                coin: alert.symbol,
                direction: alert.direction,
                target: alert.targetPrice,
                price: quote.price,
            });
        }
    }

    return fired;
}

/** Start the shared poller. Safe to call repeatedly. */
export function startAlertLoop(client) {
    if (client) {
        alertClient = client;
    }

    if (loopTimer) {
        return;
    }

    loopTimer = setInterval(() => {
        checkAlerts().catch((error) => {
            logger.warn('trade: alert sweep failed', { error: error.message });
        });
    }, ALERT_LIMITS.POLL_MS);

    // Never hold the process open purely for price alerts.
    if (typeof loopTimer.unref === 'function') {
        loopTimer.unref();
    }

    logger.info('trade: alert loop started', { pollMs: ALERT_LIMITS.POLL_MS });
}

/** Stop the poller and clear every alert — called during graceful shutdown. */
export async function stopAllAlerts(reason = 'shutdown') {
    if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = null;
    }

    const count = alerts.size;
    alerts.clear();

    logger.info('trade: alerts stopped', { reason, cleared: count });

    return count;
}

export function __setAlertClient(client) {
    alertClient = client;
}

export const __testables = { alerts, isHit };

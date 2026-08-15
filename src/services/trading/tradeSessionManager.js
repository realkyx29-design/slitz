// tradeSessionManager.js — live-updating state for /trade cards.
//
// Each /trade invocation creates a session that re-fetches the quote on a timer
// and edits its message in place. Sessions are in-memory and self-terminating:
// they stop at maxUpdates, on user request, when the message is deleted, or on
// bot shutdown, so a long-lived bot never accumulates orphaned timers.
//
// Read-only: a session polls public price APIs and edits a Discord message.
// Nothing here can place an order or move funds.

import crypto from 'node:crypto';

import { logger } from '../../utils/logger.js';
import { getQuote } from './marketDataService.js';
import { calculatePosition, calculateTwentyFourHourWhatIf } from './positionCalculator.js';
import { buildAlertContent, buildTradeButtons, buildTradeEmbed } from './tradeEmbed.js';
import { toNumber } from '../../utils/tradeFormat.js';

export const SESSION_LIMITS = {
    MIN_INTERVAL_MS: 15_000,
    DEFAULT_INTERVAL_MS: 30_000,
    MAX_INTERVAL_MS: 5 * 60 * 1000,
    DEFAULT_DURATION_MS: 15 * 60 * 1000,
    MAX_DURATION_MS: 60 * 60 * 1000,
    MAX_SESSIONS_PER_GUILD: 5,
    MAX_SESSIONS_TOTAL: 60,
    MAX_CONSECUTIVE_ERRORS: 5,
    // Only re-ping when the move since the last ping is meaningful, so a live
    // card cannot turn into a notification firehose.
    PING_CHANGE_THRESHOLD_PERCENT: 1,
    PING_MIN_INTERVAL_MS: 60_000,
};

/** sessionId -> session */
const sessions = new Map();

export function getSession(sessionId) {
    return sessions.get(sessionId) || null;
}

export function getActiveSessionCount() {
    return sessions.size;
}

function countGuildSessions(guildId) {
    let count = 0;

    for (const session of sessions.values()) {
        if (session.guildId === guildId) {
            count += 1;
        }
    }

    return count;
}

export function clampInterval(seconds) {
    const value = toNumber(seconds);

    if (value === null) {
        return SESSION_LIMITS.DEFAULT_INTERVAL_MS;
    }

    return Math.min(
        SESSION_LIMITS.MAX_INTERVAL_MS,
        Math.max(SESSION_LIMITS.MIN_INTERVAL_MS, Math.round(value * 1000)),
    );
}

export function clampDuration(minutes) {
    const value = toNumber(minutes);

    if (value === null) {
        return SESSION_LIMITS.DEFAULT_DURATION_MS;
    }

    return Math.min(
        SESSION_LIMITS.MAX_DURATION_MS,
        Math.max(60_000, Math.round(value * 60_000)),
    );
}

/**
 * Decide whether this update warrants pinging the user again.
 * Exported for testing.
 */
export function shouldPing(session, quote, { now = Date.now() } = {}) {
    if (!session.notifyUserId) {
        return false;
    }

    // Always ping on the very first render.
    if (session.lastPingAt === null) {
        return true;
    }

    if (now - session.lastPingAt < SESSION_LIMITS.PING_MIN_INTERVAL_MS) {
        return false;
    }

    const lastPrice = toNumber(session.lastPingPrice);
    const currentPrice = toNumber(quote.price);

    if (lastPrice === null || currentPrice === null || lastPrice === 0) {
        return false;
    }

    const movePercent = Math.abs(((currentPrice - lastPrice) / lastPrice) * 100);

    return movePercent >= SESSION_LIMITS.PING_CHANGE_THRESHOLD_PERCENT;
}

/** Compose the message payload for a session's current state. */
export function renderSession(session, quote, { analysis = null, ping = false } = {}) {
    const position = session.position
        ? calculatePosition({
            amount: session.position.amount,
            entryPrice: session.position.entryPrice ?? quote.price,
            currentPrice: quote.price,
        })
        : null;

    const whatIf = session.position
        ? calculateTwentyFourHourWhatIf({
            amount: session.position.amount,
            currentPrice: quote.price,
            changePercent24h: quote.change24h,
        })
        : null;

    const embed = buildTradeEmbed({
        quote,
        position,
        whatIf,
        analysis: analysis ?? session.analysis,
        live: {
            active: session.active,
            intervalMs: session.intervalMs,
            updateCount: session.updateCount,
            maxUpdates: session.maxUpdates,
        },
    });

    const components = buildTradeButtons(session.id, {
        active: session.active,
        aiEnabled: session.aiEnabled,
    });

    const content = ping
        ? buildAlertContent(session.notifyUserId, quote, position)
        : '';

    return {
        content,
        embeds: [embed],
        components,
        // Only the tracked user may be pinged — never @everyone or roles.
        allowedMentions: session.notifyUserId
            ? { users: [session.notifyUserId], parse: [] }
            : { parse: [] },
        position,
    };
}

async function applyUpdate(session, { force = true } = {}) {
    const quote = await getQuote(session.query, { force });

    if (!quote) {
        throw new Error(`No market data returned for ${session.query}`);
    }

    const now = Date.now();
    const ping = shouldPing(session, quote, { now });

    session.updateCount += 1;
    session.lastQuote = quote;
    session.lastUpdateAt = now;

    if (ping) {
        session.lastPingAt = now;
        session.lastPingPrice = quote.price;
    }

    const payload = renderSession(session, quote, { ping });

    await session.message.edit({
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
        allowedMentions: payload.allowedMentions,
    });

    return { quote, payload };
}

/** Stop a session and clear its timer. Safe to call repeatedly. */
export async function stopSession(sessionId, { reason = 'stopped', finalRender = true } = {}) {
    const session = sessions.get(sessionId);

    if (!session) {
        return false;
    }

    if (session.timer) {
        clearInterval(session.timer);
        session.timer = null;
    }

    session.active = false;
    sessions.delete(sessionId);

    logger.info('trade: live session ended', {
        sessionId,
        reason,
        updates: session.updateCount,
        coin: session.query,
    });

    if (finalRender && session.message && session.lastQuote) {
        try {
            const payload = renderSession(session, session.lastQuote, { ping: false });
            await session.message.edit({
                content: '',
                embeds: payload.embeds,
                components: payload.components,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger.debug('trade: final render failed (message likely deleted)', { error: error.message });
        }
    }

    return true;
}

/** Stop every session — called during graceful shutdown. */
export async function stopAllSessions(reason = 'shutdown') {
    const ids = [...sessions.keys()];

    await Promise.allSettled(ids.map((id) => stopSession(id, { reason, finalRender: false })));

    return ids.length;
}

/**
 * Create and start a live-updating trade session.
 *
 * @returns {{ ok: boolean, reason?: string, session?: object }}
 */
export function createSession({
    message,
    query,
    quote,
    guildId,
    channelId,
    userId,
    notifyUserId,
    position = null,
    intervalMs = SESSION_LIMITS.DEFAULT_INTERVAL_MS,
    durationMs = SESSION_LIMITS.DEFAULT_DURATION_MS,
    aiEnabled = false,
}) {
    if (sessions.size >= SESSION_LIMITS.MAX_SESSIONS_TOTAL) {
        return { ok: false, reason: 'The bot is already tracking the maximum number of live coins. Try again shortly.' };
    }

    if (guildId && countGuildSessions(guildId) >= SESSION_LIMITS.MAX_SESSIONS_PER_GUILD) {
        return {
            ok: false,
            reason: `This server already has ${SESSION_LIMITS.MAX_SESSIONS_PER_GUILD} live trackers running. Stop one before starting another.`,
        };
    }

    const sessionId = crypto.randomBytes(8).toString('hex');
    const maxUpdates = Math.max(1, Math.floor(durationMs / intervalMs));

    const session = {
        id: sessionId,
        message,
        query,
        guildId: guildId || null,
        channelId: channelId || null,
        userId,
        notifyUserId: notifyUserId || null,
        position,
        intervalMs,
        durationMs,
        maxUpdates,
        updateCount: 0,
        errorCount: 0,
        active: true,
        aiEnabled,
        analysis: null,
        lastQuote: quote || null,
        lastUpdateAt: Date.now(),
        // The first render (done by the command) counts as the first ping.
        lastPingAt: notifyUserId ? Date.now() : null,
        lastPingPrice: quote?.price ?? null,
        startedAt: Date.now(),
        timer: null,
    };

    session.timer = setInterval(async () => {
        // Timers must never throw into the event loop.
        try {
            if (!session.active) {
                return;
            }

            if (session.updateCount >= session.maxUpdates) {
                await stopSession(sessionId, { reason: 'duration_reached' });
                return;
            }

            await applyUpdate(session);
            session.errorCount = 0;
        } catch (error) {
            session.errorCount += 1;

            // The message is gone (deleted, or channel/permissions changed):
            // there is nothing left to update, so retire the session quietly.
            const code = error?.code;
            if (code === 10008 || code === 10003 || code === 50001 || code === 50013) {
                logger.info('trade: stopping session, message unreachable', { sessionId, code });
                await stopSession(sessionId, { reason: 'message_unreachable', finalRender: false });
                return;
            }

            logger.warn('trade: live update failed', {
                sessionId,
                coin: session.query,
                attempt: session.errorCount,
                error: error.message,
            });

            if (session.errorCount >= SESSION_LIMITS.MAX_CONSECUTIVE_ERRORS) {
                await stopSession(sessionId, { reason: 'too_many_errors' });
            }
        }
    }, intervalMs);

    // Do not hold the process open purely for a price ticker.
    if (typeof session.timer.unref === 'function') {
        session.timer.unref();
    }

    sessions.set(sessionId, session);

    logger.info('trade: live session started', {
        sessionId,
        coin: query,
        intervalMs,
        maxUpdates,
        guildId,
    });

    return { ok: true, session };
}

/** Force an immediate refresh (Refresh button). */
export async function refreshSession(sessionId) {
    const session = sessions.get(sessionId);

    if (!session) {
        return { ok: false, reason: 'expired' };
    }

    try {
        const { quote } = await applyUpdate(session);
        session.errorCount = 0;
        return { ok: true, quote };
    } catch (error) {
        logger.warn('trade: manual refresh failed', { sessionId, error: error.message });
        return { ok: false, reason: 'fetch_failed' };
    }
}

/** Attach AI commentary to a session and re-render. */
export async function setSessionAnalysis(sessionId, analysis) {
    const session = sessions.get(sessionId);

    if (!session || !session.lastQuote) {
        return false;
    }

    session.analysis = analysis;

    const payload = renderSession(session, session.lastQuote, { ping: false });

    await session.message.edit({
        content: '',
        embeds: payload.embeds,
        components: payload.components,
        allowedMentions: { parse: [] },
    });

    return true;
}

export const __testables = { sessions, applyUpdate };

// tradeButtons.js — button handlers for the /trade card.
//
// All three actions are read-only: refresh market data, request AI commentary,
// or stop the live poller. None of them can trade or move funds.

import { MessageFlags } from 'discord.js';

import { logger } from '../utils/logger.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import {
    clampDuration,
    clampInterval,
    createSession,
    getSession,
    refreshSession,
    SESSION_LIMITS,
    setSessionAnalysis,
    stopSession,
} from '../services/trading/tradeSessionManager.js';
import { analyzeMarket, isAnalystEnabled } from '../services/trading/tradeAnalyst.js';
import { getQuote, MarketDataError, normalizeQuery } from '../services/trading/marketDataService.js';
import { calculatePosition, calculateTwentyFourHourWhatIf } from '../services/trading/positionCalculator.js';
import { buildTradeButtons, buildTradeEmbed } from '../services/trading/tradeEmbed.js';
import { toNumber } from '../utils/tradeFormat.js';

const EXPIRED_MESSAGE = 'This tracker has already stopped. Run `/trade` again to start a new one.';

async function ack(interaction) {
    if (interaction.deferred || interaction.replied) {
        return true;
    }

    try {
        await interaction.deferUpdate();
        return true;
    } catch (error) {
        logger.debug('trade: button ack failed', { error: error.message });
        return false;
    }
}

async function quietFollowUp(interaction, content) {
    try {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } catch (error) {
        logger.debug('trade: follow-up failed', { error: error.message });
    }
}

export const tradeRefreshButton = {
    name: 'trade_refresh',
    async execute(interaction, client, args = []) {
        const [sessionId] = args;

        if (!sessionId || !getSession(sessionId)) {
            await ack(interaction);
            await quietFollowUp(interaction, EXPIRED_MESSAGE);
            return;
        }

        // Manual refreshes hit the upstream API, so throttle per user.
        const allowed = await checkRateLimit(`trade_refresh:${interaction.user.id}`, 5, 30_000);

        if (!allowed) {
            await ack(interaction);
            await quietFollowUp(interaction, 'Slow down — you can refresh again in a few seconds.');
            return;
        }

        await ack(interaction);

        const result = await refreshSession(sessionId);

        if (!result.ok) {
            await quietFollowUp(
                interaction,
                result.reason === 'expired'
                    ? EXPIRED_MESSAGE
                    : 'Could not fetch fresh market data. The next scheduled update will retry.',
            );
        }
    },
};

export const tradeStopButton = {
    name: 'trade_stop',
    async execute(interaction, client, args = []) {
        const [sessionId] = args;
        const session = getSession(sessionId);

        if (!sessionId || !session) {
            await ack(interaction);
            await quietFollowUp(interaction, EXPIRED_MESSAGE);
            return;
        }

        // Only the person who started it (or a server manager) may stop it.
        const isOwner = interaction.user.id === session.userId;
        const canManage = interaction.memberPermissions?.has('ManageMessages') ?? false;

        if (!isOwner && !canManage) {
            await ack(interaction);
            await quietFollowUp(interaction, 'Only the person who started this tracker can stop it.');
            return;
        }

        await ack(interaction);
        await stopSession(sessionId, { reason: 'user_stopped' });
        await quietFollowUp(interaction, 'Live updates stopped. The card shows the final values.');
    },
};

export const tradeAnalyzeButton = {
    name: 'trade_analyze',
    async execute(interaction, client, args = []) {
        const [sessionId] = args;
        const session = getSession(sessionId);

        if (!sessionId || !session) {
            await ack(interaction);
            await quietFollowUp(interaction, EXPIRED_MESSAGE);
            return;
        }

        if (!isAnalystEnabled()) {
            await ack(interaction);
            await quietFollowUp(interaction, 'AI analysis is not configured on this bot.');
            return;
        }

        const allowed = await checkRateLimit(`trade_analyze:${interaction.user.id}`, 3, 60_000);

        if (!allowed) {
            await ack(interaction);
            await quietFollowUp(interaction, 'You have requested a few reads already — try again in a minute.');
            return;
        }

        await ack(interaction);

        if (!session.lastQuote) {
            await quietFollowUp(interaction, 'No market data cached yet. Try refreshing first.');
            return;
        }

        const position = session.position
            ? {
                amount: session.position.amount,
                entryPrice: session.position.entryPrice,
                currentPrice: session.lastQuote.price,
            }
            : null;

        const analysis = await analyzeMarket(
            session.lastQuote,
            position
                ? {
                    ...position,
                    // analyzeMarket only reads these display fields.
                    currentValue: (position.amount / position.entryPrice) * position.currentPrice,
                    profitLoss: ((position.amount / position.entryPrice) * position.currentPrice) - position.amount,
                    profitLossPercent: ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100,
                }
                : null,
        );

        if (!analysis) {
            await quietFollowUp(interaction, 'The AI analyst is unavailable right now. Market data is still live.');
            return;
        }

        const updated = await setSessionAnalysis(sessionId, analysis).catch((error) => {
            logger.warn('trade: failed to render analysis', { error: error.message });
            return false;
        });

        if (!updated) {
            await quietFollowUp(interaction, EXPIRED_MESSAGE);
        }
    },
};

export const tradeTrackButton = {
    name: 'trade_track',
    async execute(interaction, client, args = []) {
        const [rawQuery, rawAmount] = args;
        const query = normalizeQuery(rawQuery);
        const amount = toNumber(rawAmount);

        if (!query) {
            await ack(interaction);
            await quietFollowUp(interaction, 'That signal card is missing its coin. Run `/trade signals` again.');
            return;
        }

        // Spinning up a poller from a button counts as tracker creation too.
        const allowed = await checkRateLimit(`trade:${interaction.user.id}`, 5, 60_000);

        if (!allowed) {
            await ack(interaction);
            await quietFollowUp(interaction, 'You are starting trackers too quickly. Wait a minute and try again.');
            return;
        }

        await interaction.deferReply().catch(() => {});

        let quote;

        try {
            quote = await getQuote(query, { force: true });
        } catch (error) {
            const message = error instanceof MarketDataError && error.code === 'rate_limited'
                ? 'The market data provider is rate limiting requests right now. Try again in a minute.'
                : 'Could not load market data right now. Please try again shortly.';
            await interaction.editReply({ content: message }).catch(() => {});
            return;
        }

        if (!quote) {
            await interaction.editReply({
                content: `No market data found for **${query.slice(0, 60)}** — the token may have been pulled.`,
            }).catch(() => {});
            return;
        }

        // The signal's hypothetical stake becomes the tracked what-if position,
        // entered at the current price.
        const position = amount !== null && amount > 0
            ? calculatePosition({ amount, entryPrice: quote.price, currentPrice: quote.price })
            : null;

        const whatIf = amount !== null && amount > 0
            ? calculateTwentyFourHourWhatIf({ amount, currentPrice: quote.price, changePercent24h: quote.change24h })
            : null;

        const aiEnabled = isAnalystEnabled();
        const intervalMs = clampInterval(null);
        const durationMs = clampDuration(null);

        const embed = buildTradeEmbed({
            quote,
            position,
            whatIf,
            analysis: null,
            live: {
                active: true,
                intervalMs,
                updateCount: 0,
                maxUpdates: Math.max(1, Math.floor(durationMs / intervalMs)),
            },
        });

        const sent = await interaction.editReply({
            content: '',
            embeds: [embed],
            components: buildTradeButtons('pending', { active: true, aiEnabled }),
            allowedMentions: { parse: [] },
        }).catch(() => null);

        if (!sent || typeof sent.edit !== 'function') {
            return;
        }

        const notifyUserId = interaction.user.id;

        const created = createSession({
            message: sent,
            query,
            quote,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            notifyUserId,
            position: position ? { amount: position.amount, entryPrice: position.entryPrice } : null,
            intervalMs,
            durationMs,
            aiEnabled,
        });

        if (!created.ok) {
            await sent.edit({
                components: buildTradeButtons('pending', { active: false, aiEnabled }),
            }).catch(() => {});
            await quietFollowUp(interaction, created.reason);
            return;
        }

        await sent.edit({
            components: buildTradeButtons(created.session.id, { active: true, aiEnabled }),
        }).catch((error) => {
            logger.warn('trade: failed to attach session buttons', { error: error.message });
        });

        logger.info('trade: tracker started from signal card', {
            coin: quote.symbol,
            sessionId: created.session.id,
            userId: interaction.user.id,
        });
    },
};

export default [tradeRefreshButton, tradeStopButton, tradeAnalyzeButton, tradeTrackButton];

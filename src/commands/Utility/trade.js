// /trade — live memecoin tracker with hypothetical profit/loss modelling.
//
// This command is READ-ONLY. It reads public market data and does arithmetic.
// It cannot buy, sell, custody, or transfer anything, and it is deliberately
// not wired to the bot economy.

import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';
import { getQuote, MarketDataError, normalizeQuery } from '../../services/trading/marketDataService.js';
import {
    calculatePosition,
    calculateTwentyFourHourWhatIf,
    validatePosition,
} from '../../services/trading/positionCalculator.js';
import { buildAlertContent, buildTradeButtons, buildTradeEmbed } from '../../services/trading/tradeEmbed.js';
import { analyzeMarket, isAnalystEnabled } from '../../services/trading/tradeAnalyst.js';
import { scanMemeMarket } from '../../services/trading/memeScanner.js';
import { buildMemeScanEmbed } from '../../services/trading/memeScanEmbed.js';
import {
    clampDuration,
    clampInterval,
    createSession,
    SESSION_LIMITS,
} from '../../services/trading/tradeSessionManager.js';

/** Who gets pinged when a card is generated or updated. */
export const DEFAULT_TRADE_NOTIFY_USER_ID = '1377402826514235442';

export function resolveNotifyUserId(env = process.env) {
    const configured = String(env.TRADE_NOTIFY_USER_ID || '').trim();

    // Discord snowflakes are 17-20 digits.
    if (/^\d{17,20}$/.test(configured)) {
        return configured;
    }

    return DEFAULT_TRADE_NOTIFY_USER_ID;
}

export default {
    data: new SlashCommandBuilder()
        .setName('trade')
        .setDescription('Scan memecoins or open a live, read-only market tracker')
        .addStringOption((option) =>
            option
                .setName('mode')
                .setDescription('Scan the market or inspect one coin (default: coin)')
                .addChoices(
                    { name: 'Market scan — find momentum and risk', value: 'scan' },
                    { name: 'Coin tracker — inspect one token', value: 'coin' },
                )
                .setRequired(false))
        .addStringOption((option) =>
            option
                .setName('coin')
                .setDescription('Ticker, name, or contract address (required in coin mode)')
                .setRequired(false)
                .setMaxLength(100))
        .addNumberOption((option) =>
            option
                .setName('amount')
                .setDescription('Hypothetical USD invested, to calculate profit/loss')
                .setRequired(false)
                .setMinValue(0.01))
        .addNumberOption((option) =>
            option
                .setName('entry')
                .setDescription('Your entry price per token (defaults to the current price)')
                .setRequired(false)
                .setMinValue(0))
        .addIntegerOption((option) =>
            option
                .setName('interval')
                .setDescription('Seconds between live updates (15-300, default 30)')
                .setRequired(false)
                .setMinValue(15)
                .setMaxValue(300))
        .addIntegerOption((option) =>
            option
                .setName('duration')
                .setDescription('Minutes to keep updating (1-60, default 15)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(60))
        .addBooleanOption((option) =>
            option
                .setName('live')
                .setDescription('Keep the card auto-updating (default: true)')
                .setRequired(false))
        .addBooleanOption((option) =>
            option
                .setName('analysis')
                .setDescription('Include an AI read of the market data (analysis only, never trades)')
                .setRequired(false)),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);

        if (!deferSuccess) {
            logger.warn('trade: interaction defer failed', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'trade',
            });
            return;
        }

        const mode = interaction.options.getString('mode') || 'coin';

        if (mode === 'scan') {
            const allowed = await checkRateLimit(`trade_scan:${interaction.user.id}`, 3, 60_000);
            if (!allowed) {
                await replyUserError(interaction, {
                    type: ErrorTypes.RATE_LIMIT,
                    message: 'The market radar was refreshed recently. Wait a moment and try again.',
                });
                return;
            }

            try {
                const scan = await scanMemeMarket();
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [buildMemeScanEmbed(scan)],
                    allowedMentions: { parse: [] },
                });
            } catch (error) {
                logger.warn('trade: market scan failed', { error: error.message, code: error.code });
                await replyUserError(interaction, {
                    type: ErrorTypes.NETWORK,
                    message: error.code === 'rate_limited'
                        ? 'The market data provider is rate limiting scans. Try again in a minute.'
                        : 'The memecoin radar could not load market data. Please try again shortly.',
                });
            }
            return;
        }

        const rawCoin = interaction.options.getString('coin');
        const coin = normalizeQuery(rawCoin);

        if (!coin) {
            await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'Coin mode needs a ticker, token name, or contract address. Or choose `mode: Market scan`.',
            });
            return;
        }

        // Live pollers are shared infrastructure — throttle how fast one user
        // can spin them up so a single person cannot exhaust the API budget.
        const allowed = await checkRateLimit(`trade:${interaction.user.id}`, 5, 60_000);

        if (!allowed) {
            await replyUserError(interaction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'You are starting trackers too quickly. Wait a minute and try again.',
            });
            return;
        }

        const amount = interaction.options.getNumber('amount');
        const entry = interaction.options.getNumber('entry');
        const wantsLive = interaction.options.getBoolean('live') ?? true;
        const wantsAnalysis = interaction.options.getBoolean('analysis') ?? false;
        const intervalMs = clampInterval(interaction.options.getInteger('interval'));
        const durationMs = clampDuration(interaction.options.getInteger('duration'));

        // An entry price is only meaningful alongside an amount.
        if (entry !== null && amount === null) {
            await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'Provide an `amount` as well so the profit/loss can be calculated from your `entry` price.',
            });
            return;
        }

        let quote;

        try {
            quote = await getQuote(coin, { force: true });
        } catch (error) {
            if (error instanceof MarketDataError) {
                await replyUserError(interaction, {
                    type: error.retryable ? ErrorTypes.NETWORK : ErrorTypes.USER_INPUT,
                    message: error.code === 'rate_limited'
                        ? 'The market data provider is rate limiting requests right now. Try again in a minute.'
                        : error.message,
                });
                return;
            }

            logger.error('trade: unexpected market data failure', {
                coin,
                error: error.message,
                stack: error.stack,
            });

            await replyUserError(interaction, {
                type: ErrorTypes.NETWORK,
                message: 'Could not load market data right now. Please try again shortly.',
            });
            return;
        }

        if (!quote) {
            await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `No market data found for **${coin.slice(0, 60)}**. `
                    + 'Try the exact ticker (e.g. `BONK`), the full name (e.g. `dogwifhat`), '
                    + 'or paste the token contract address.',
            });
            return;
        }

        // Build the hypothetical position, if one was requested.
        let position = null;
        let whatIf = null;
        const entryPrice = entry ?? quote.price;

        if (amount !== null) {
            const validation = validatePosition({ amount, entryPrice });

            if (!validation.ok) {
                await replyUserError(interaction, {
                    type: ErrorTypes.USER_INPUT,
                    message: validation.reason,
                });
                return;
            }

            position = calculatePosition({
                amount,
                entryPrice,
                currentPrice: quote.price,
            });

            whatIf = calculateTwentyFourHourWhatIf({
                amount,
                currentPrice: quote.price,
                changePercent24h: quote.change24h,
            });
        }

        const aiEnabled = isAnalystEnabled();
        let analysis = null;

        if (wantsAnalysis) {
            if (!aiEnabled) {
                logger.info('trade: analysis requested but no AI provider configured');
            } else {
                analysis = await analyzeMarket(quote, position);
            }
        }

        const notifyUserId = resolveNotifyUserId();

        const embed = buildTradeEmbed({
            quote,
            position,
            whatIf,
            analysis,
            live: wantsLive
                ? {
                    active: true,
                    intervalMs,
                    updateCount: 0,
                    maxUpdates: Math.max(1, Math.floor(durationMs / intervalMs)),
                }
                : null,
        });

        // Ping in message content: mentions inside an embed never notify.
        const content = buildAlertContent(notifyUserId, quote, position);

        // safeEditReply resolves to a boolean, so the message is fetched separately.
        const sent = await InteractionHelper.safeEditReply(interaction, {
            content,
            embeds: [embed],
            components: wantsLive
                ? buildTradeButtons('pending', { active: true, aiEnabled })
                : [],
            allowedMentions: { users: [notifyUserId], parse: [] },
        });

        if (!sent) {
            logger.warn('trade: could not deliver the trade card', {
                userId: interaction.user.id,
                coin,
            });
            return;
        }

        if (!wantsLive) {
            return;
        }

        // Resolve the real message so the session can edit it on a timer.
        const liveMessage = await interaction.fetchReply().catch(() => null);

        if (!liveMessage || typeof liveMessage.edit !== 'function') {
            logger.warn('trade: could not resolve reply message, live updates disabled', {
                userId: interaction.user.id,
                coin,
            });
            return;
        }

        const created = createSession({
            message: liveMessage,
            query: coin,
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
            await liveMessage.edit({
                components: buildTradeButtons('pending', { active: false, aiEnabled }),
            }).catch(() => {});

            await interaction.followUp({
                content: created.reason,
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});

            return;
        }

        // Re-render with the real session id bound to the buttons.
        await liveMessage.edit({
            components: buildTradeButtons(created.session.id, { active: true, aiEnabled }),
        }).catch((error) => {
            logger.warn('trade: failed to attach session buttons', { error: error.message });
        });

        logger.info('trade: card created', {
            coin: quote.symbol,
            source: quote.source,
            live: true,
            hasPosition: Boolean(position),
            sessionId: created.session.id,
            userId: interaction.user.id,
        });
    },
};

export const SESSION_DEFAULTS = SESSION_LIMITS;

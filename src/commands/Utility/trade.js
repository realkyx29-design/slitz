// /trade — memecoin research suite: live tracker, market radar, momentum
// signals, what-if simulator, fresh-token board and price alerts.
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
import {
    buildAlertContent,
    buildSignalButtons,
    buildSignalContent,
    buildSignalEmbed,
    buildSimulateEmbed,
    buildTradeButtons,
    buildTradeEmbed,
    buildTrendingEmbed,
    buildWatchAddEmbed,
    buildWatchListEmbed,
} from '../../services/trading/tradeEmbed.js';
import { analyzeMarket, isAnalystEnabled } from '../../services/trading/tradeAnalyst.js';
import { scanMemeMarket } from '../../services/trading/memeScanner.js';
import { buildMemeScanEmbed } from '../../services/trading/memeScanEmbed.js';
import { getTrendingTokens } from '../../services/trading/memeTrending.js';
import {
    addAlert,
    getAlertsForUser,
    removeAlerts,
    startAlertLoop,
} from '../../services/trading/tradeAlerts.js';
import {
    buildSignal,
    buildSimulationScenarios,
    resolveSignalBudget,
} from '../../services/trading/signalEngine.js';
import {
    clampDuration,
    clampInterval,
    createSession,
    SESSION_LIMITS,
} from '../../services/trading/tradeSessionManager.js';
import { formatPrice } from '../../utils/tradeFormat.js';

/** Who gets pinged when a card or signal is generated. */
export const DEFAULT_TRADE_NOTIFY_USER_ID = '1377402826514235442';

export function resolveNotifyUserId(env = process.env) {
    const configured = String(env.TRADE_NOTIFY_USER_ID || '').trim();

    // Discord snowflakes are 17-20 digits.
    if (/^\d{17,20}$/.test(configured)) {
        return configured;
    }

    return DEFAULT_TRADE_NOTIFY_USER_ID;
}

/** Shared failure path for market data lookups. */
async function marketDataFailure(interaction, error) {
    if (error instanceof MarketDataError) {
        await replyUserError(interaction, {
            type: error.retryable ? ErrorTypes.NETWORK : ErrorTypes.USER_INPUT,
            message: error.code === 'rate_limited'
                ? 'The market data provider is rate limiting requests right now. Try again in a minute.'
                : error.message,
        });
        return;
    }

    logger.error('trade: unexpected market data failure', { error: error.message, stack: error.stack });

    await replyUserError(interaction, {
        type: ErrorTypes.NETWORK,
        message: 'Could not load market data right now. Please try again shortly.',
    });
}

// ---------------------------------------------------------------------------
// Subcommand: coin — the live tracker card.
// ---------------------------------------------------------------------------
async function executeCoin(interaction) {
    const rawCoin = interaction.options.getString('coin');
    const coin = normalizeQuery(rawCoin);

    if (!coin) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: 'Provide a ticker, token name, or contract address — e.g. `BONK`, `dogwifhat`, or the contract.',
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
        await marketDataFailure(interaction, error);
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
}

// ---------------------------------------------------------------------------
// Subcommand: scan — the broad memecoin radar.
// ---------------------------------------------------------------------------
async function executeScan(interaction) {
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
}

// ---------------------------------------------------------------------------
// Subcommand: signals — find what is heading up, size a hypothetical entry,
// project the outcomes, and ping the configured user.
// ---------------------------------------------------------------------------
async function executeSignals(interaction) {
    const allowed = await checkRateLimit(`trade_signals:${interaction.user.id}`, 3, 60_000);
    if (!allowed) {
        await replyUserError(interaction, {
            type: ErrorTypes.RATE_LIMIT,
            message: 'The signal radar was refreshed recently. Wait a moment and try again.',
        });
        return;
    }

    const budgetOption = interaction.options.getNumber('budget');
    const budget = budgetOption ?? resolveSignalBudget();

    let scan;

    try {
        scan = await scanMemeMarket();
    } catch (error) {
        logger.warn('trade: signal scan failed', { error: error.message, code: error.code });
        await replyUserError(interaction, {
            type: ErrorTypes.NETWORK,
            message: error.code === 'rate_limited'
                ? 'The market data provider is rate limiting scans. Try again in a minute.'
                : 'The signal radar could not load market data. Please try again shortly.',
        });
        return;
    }

    const signal = buildSignal({ scan, budget });

    if (!signal) {
        await InteractionHelper.safeEditReply(interaction, {
            content: 'No coin is showing clean upward momentum with acceptable liquidity right now. '
                + 'The radar stays quiet rather than point at a weak setup — try again later.',
            allowedMentions: { parse: [] },
        });
        return;
    }

    const notifyUserId = resolveNotifyUserId();

    const sent = await InteractionHelper.safeEditReply(interaction, {
        content: buildSignalContent(notifyUserId, signal),
        embeds: [buildSignalEmbed({ signal })],
        components: buildSignalButtons(signal.primary.id || signal.primary.symbol, signal.stake.amount),
        allowedMentions: { users: [notifyUserId], parse: [] },
    });

    if (!sent) {
        logger.warn('trade: could not deliver the signal card', { userId: interaction.user.id });
        return;
    }

    logger.info('trade: signal card created', {
        coin: signal.primary.symbol,
        score: signal.primary.score,
        stake: signal.stake.amount,
        userId: interaction.user.id,
    });
}

// ---------------------------------------------------------------------------
// Subcommand: simulate — the standalone "how much would I get" ladder.
// ---------------------------------------------------------------------------
async function executeSimulate(interaction) {
    const coin = normalizeQuery(interaction.options.getString('coin'));
    const amount = interaction.options.getNumber('amount');

    if (!coin) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: 'Provide a ticker, token name, or contract address to simulate.',
        });
        return;
    }

    const allowed = await checkRateLimit(`trade_simulate:${interaction.user.id}`, 5, 60_000);
    if (!allowed) {
        await replyUserError(interaction, {
            type: ErrorTypes.RATE_LIMIT,
            message: 'You are running simulations too quickly. Wait a moment and try again.',
        });
        return;
    }

    let quote;

    try {
        quote = await getQuote(coin, { force: true });
    } catch (error) {
        await marketDataFailure(interaction, error);
        return;
    }

    if (!quote) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: `No market data found for **${coin.slice(0, 60)}**. Try the exact ticker or the contract address.`,
        });
        return;
    }

    const validation = validatePosition({ amount, entryPrice: quote.price });

    if (!validation.ok) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: validation.reason,
        });
        return;
    }

    const scenarios = buildSimulationScenarios(quote, amount);
    const whatIf = calculateTwentyFourHourWhatIf({
        amount,
        currentPrice: quote.price,
        changePercent24h: quote.change24h,
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildSimulateEmbed({ quote, amount, scenarios, whatIf })],
        allowedMentions: { parse: [] },
    });
}

// ---------------------------------------------------------------------------
// Subcommand: trending — freshly boosted on-chain tokens.
// ---------------------------------------------------------------------------
async function executeTrending(interaction) {
    const allowed = await checkRateLimit(`trade_trending:${interaction.user.id}`, 3, 60_000);
    if (!allowed) {
        await replyUserError(interaction, {
            type: ErrorTypes.RATE_LIMIT,
            message: 'The boosts board was refreshed recently. Wait a moment and try again.',
        });
        return;
    }

    try {
        const trending = await getTrendingTokens();
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [buildTrendingEmbed(trending)],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        logger.warn('trade: trending board failed', { error: error.message, code: error.code });
        await replyUserError(interaction, {
            type: ErrorTypes.NETWORK,
            message: error.code === 'rate_limited'
                ? 'The market data provider is rate limiting requests. Try again in a minute.'
                : 'The boosts board could not load right now. Please try again shortly.',
        });
    }
}

// ---------------------------------------------------------------------------
// Subcommand group: watch — one-shot price alerts.
// ---------------------------------------------------------------------------
async function executeWatchAdd(interaction) {
    const coin = normalizeQuery(interaction.options.getString('coin'));
    const targetPrice = interaction.options.getNumber('price');
    const direction = interaction.options.getString('direction') || 'above';

    if (!coin) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: 'Provide the coin to watch — ticker, name, or contract address.',
        });
        return;
    }

    let quote;

    try {
        quote = await getQuote(coin, { force: true });
    } catch (error) {
        await marketDataFailure(interaction, error);
        return;
    }

    if (!quote) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: `No market data found for **${coin.slice(0, 60)}** — cannot watch a coin without a price.`,
        });
        return;
    }

    // Catch targets that are already crossed — they would fire instantly.
    const alreadyCrossed = direction === 'above'
        ? quote.price >= targetPrice
        : quote.price <= targetPrice;

    if (alreadyCrossed) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: `${quote.symbol} is already trading **${direction}** that target `
                + `(now ≈ ${formatPrice(quote.price)}). Pick a price it has not reached yet.`,
        });
        return;
    }

    const created = addAlert({
        userId: interaction.user.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        query: quote.id || coin,
        symbol: quote.symbol,
        targetPrice,
        direction,
        basePrice: quote.price,
    });

    if (!created.ok) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: created.reason,
        });
        return;
    }

    startAlertLoop(interaction.client);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildWatchAddEmbed({ quote, alert: created.alert })],
        allowedMentions: { parse: [] },
    });

    logger.info('trade: alert registered', {
        coin: quote.symbol,
        direction,
        targetPrice,
        replaced: Boolean(created.replaced),
        userId: interaction.user.id,
    });
}

async function executeWatchList(interaction) {
    const userAlerts = getAlertsForUser(interaction.user.id)
        .sort((a, b) => b.createdAt - a.createdAt);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildWatchListEmbed(userAlerts)],
        allowedMentions: { parse: [] },
    });
}

async function executeWatchRemove(interaction) {
    const coin = normalizeQuery(interaction.options.getString('coin'));

    const result = removeAlerts(interaction.user.id, coin);

    await InteractionHelper.safeEditReply(interaction, {
        content: result.ok
            ? `Removed your alert${result.removed > 1 ? 's' : ''} for **${coin.slice(0, 60)}**.`
            : `You have no alert set for **${coin.slice(0, 60)}**. Check \`/trade watch list\`.`,
        allowedMentions: { parse: [] },
    });
}

export default {
    data: new SlashCommandBuilder()
        .setName('trade')
        .setDescription('Memecoin research: live tracker, radar, signals, simulator, boosts and price alerts')

        .addSubcommand((sub) => sub
            .setName('coin')
            .setDescription('Open a live, read-only market card for one coin')
            .addStringOption((option) => option
                .setName('coin')
                .setDescription('Ticker, name, or contract address (e.g. BONK, dogwifhat)')
                .setRequired(true)
                .setMaxLength(100))
            .addNumberOption((option) => option
                .setName('amount')
                .setDescription('Hypothetical USD invested, to calculate profit/loss')
                .setRequired(false)
                .setMinValue(0.01))
            .addNumberOption((option) => option
                .setName('entry')
                .setDescription('Your entry price per token (defaults to the current price)')
                .setRequired(false)
                .setMinValue(0))
            .addIntegerOption((option) => option
                .setName('interval')
                .setDescription('Seconds between live updates (15-300, default 30)')
                .setRequired(false)
                .setMinValue(15)
                .setMaxValue(300))
            .addIntegerOption((option) => option
                .setName('duration')
                .setDescription('Minutes to keep updating (1-60, default 15)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(60))
            .addBooleanOption((option) => option
                .setName('live')
                .setDescription('Keep the card auto-updating (default: true)')
                .setRequired(false))
            .addBooleanOption((option) => option
                .setName('analysis')
                .setDescription('Include an AI read of the market data (analysis only, never trades)')
                .setRequired(false)))

        .addSubcommand((sub) => sub
            .setName('scan')
            .setDescription('Scan the memecoin market for momentum, activity and risk'))

        .addSubcommand((sub) => sub
            .setName('signals')
            .setDescription('Find coins heading up, size a hypothetical entry, and project outcomes')
            .addNumberOption((option) => option
                .setName('budget')
                .setDescription('Hypothetical USD budget to size against (default from config)')
                .setRequired(false)
                .setMinValue(5)
                .setMaxValue(1_000_000)))

        .addSubcommand((sub) => sub
            .setName('simulate')
            .setDescription('How much would I get? Ladder of hypothetical outcomes for one coin')
            .addStringOption((option) => option
                .setName('coin')
                .setDescription('Ticker, name, or contract address')
                .setRequired(true)
                .setMaxLength(100))
            .addNumberOption((option) => option
                .setName('amount')
                .setDescription('Hypothetical USD invested at the current price')
                .setRequired(true)
                .setMinValue(0.01)))

        .addSubcommand((sub) => sub
            .setName('trending')
            .setDescription('Freshly boosted on-chain memecoins (DexScreener) — highest risk tier'))

        .addSubcommandGroup((group) => group
            .setName('watch')
            .setDescription('One-shot price alerts')
            .addSubcommand((sub) => sub
                .setName('add')
                .setDescription('Ping me when a coin crosses a price')
                .addStringOption((option) => option
                    .setName('coin')
                    .setDescription('Ticker, name, or contract address')
                    .setRequired(true)
                    .setMaxLength(100))
                .addNumberOption((option) => option
                    .setName('price')
                    .setDescription('Target price in USD')
                    .setRequired(true)
                    .setMinValue(0.000000001))
                .addStringOption((option) => option
                    .setName('direction')
                    .setDescription('Fire when the price goes… (default: above)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Above the target', value: 'above' },
                        { name: 'Below the target', value: 'below' },
                    )))
            .addSubcommand((sub) => sub
                .setName('list')
                .setDescription('Show your active price alerts'))
            .addSubcommand((sub) => sub
                .setName('remove')
                .setDescription('Remove your alerts for a coin')
                .addStringOption((option) => option
                    .setName('coin')
                    .setDescription('The coin you set the alert with')
                    .setRequired(true)
                    .setMaxLength(100)))),

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

        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand(true);

        if (subcommandGroup === 'watch') {
            if (subcommand === 'add') return executeWatchAdd(interaction);
            if (subcommand === 'list') return executeWatchList(interaction);
            if (subcommand === 'remove') return executeWatchRemove(interaction);
            return undefined;
        }

        switch (subcommand) {
            case 'coin':
                return executeCoin(interaction);
            case 'scan':
                return executeScan(interaction);
            case 'signals':
                return executeSignals(interaction);
            case 'simulate':
                return executeSimulate(interaction);
            case 'trending':
                return executeTrending(interaction);
            default:
                await replyUserError(interaction, {
                    type: ErrorTypes.USER_INPUT,
                    message: `Unknown subcommand \`${subcommand}\`.`,
                });
                return undefined;
        }
    },
};

export const SESSION_DEFAULTS = SESSION_LIMITS;

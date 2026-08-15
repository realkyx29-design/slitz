// tradeEmbed.js — builds the /trade market card.
//
// Layout mirrors the reference design: a dark card with the coin name on the
// left, a large price on the right, a 7d sparkline with high/low markers, and a
// row of stat tiles underneath (1h, 7d, Volume 24h, Market cap).
//
// Note on glyphs: src/utils/embeds.js strips emoji from titles and field names,
// so all directional indicators use geometric characters (▲ ▼ ▬ █ ▁) which
// survive sanitizing and render identically on desktop and mobile.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import { getColor } from '../../config/bot.js';
import { createEmbed } from '../../utils/embeds.js';
import {
    arrowFor,
    buildAlignedRows,
    buildSparkline,
    directionOf,
    discordRelative,
    displayName,
    formatCompact,
    formatPercent,
    formatPercentWithArrow,
    formatPrice,
    formatSignedMoney,
    formatUnits,
    PAD,
    toNumber,
} from '../../utils/tradeFormat.js';
import { MARKET_SOURCES } from './marketDataService.js';
import { scoreMemeCoin } from './memeScanner.js';

// Resolved from botConfig.embeds.colors so the card follows the bot's theme
// instead of hardcoding hex. getColor() falls back to the literal if the config
// key is missing, so the card still renders on a stripped-down config.
export const TRADE_COLORS = {
    up: getColor('success', '#57F287'),
    down: getColor('error', '#ED4245'),
    flat: getColor('#99AAB5'),
};

const SOURCE_LABELS = {
    [MARKET_SOURCES.COINGECKO]: 'CoinGecko',
    [MARKET_SOURCES.DEXSCREENER]: 'DexScreener',
};

/** Custom id prefixes — must match the handlers in src/handlers/tradeButtons.js. */
export const TRADE_BUTTON_IDS = {
    REFRESH: 'trade_refresh',
    STOP: 'trade_stop',
    ANALYZE: 'trade_analyze',
};

function colorFor(direction) {
    return TRADE_COLORS[direction] || TRADE_COLORS.flat;
}

/**
 * Header block: coin identity on the left, price and 24h move right-aligned,
 * mirroring the reference card. Rendered in a code block so the monospace
 * font makes the two columns line up on both desktop and mobile.
 */
const HEADER_WIDTH = 34;

function alignRow(left, right, width = HEADER_WIDTH) {
    // PAD (non-breaking space) survives the embed sanitizer, which collapses
    // runs of ordinary spaces and would otherwise flatten these columns.
    const gap = Math.max(1, width - left.length - right.length);
    return `${left}${PAD.repeat(gap)}${right}`;
}

function buildHeaderBlock(quote) {
    const name = displayName(quote.name).toUpperCase().slice(0, 18);
    const pair = `${quote.symbol || '?'} / USD`;
    const price = formatPrice(quote.price);
    const change = quote.change24h;

    const changeText = toNumber(change) === null
        ? ''
        : `${arrowFor(change)} ${formatPercent(change)} 24h`;

    // Widen the row if a long name and a long price would otherwise touch.
    const width = Math.max(
        HEADER_WIDTH,
        name.length + price.length + 2,
        pair.length + changeText.length + 2,
    );

    return [
        alignRow(name, price, width),
        alignRow(pair, changeText, width),
    ].join('\n');
}

/** Sparkline block with 7d high/low labels, mirroring the reference chart. */
function buildChartBlock(quote) {
    const sparkline = buildSparkline(quote.sparkline, { width: HEADER_WIDTH });

    if (!sparkline) {
        return null;
    }

    const points = quote.sparkline.map(toNumber).filter((value) => value !== null);

    if (points.length < 2) {
        return null;
    }

    const high = Math.max(...points);
    const low = Math.min(...points);

    // High label above the chart, low label below — same as the reference.
    return [
        alignRow('7d high', formatPrice(high), Math.max(HEADER_WIDTH, sparkline.length)),
        sparkline,
        alignRow('7d low', formatPrice(low), Math.max(HEADER_WIDTH, sparkline.length)),
    ].join('\n');
}

/** The stat tiles under the chart. */
function buildStatFields(quote) {
    const fields = [];
    const unknown = '—';

    const push = (name, value, inline = true) => {
        fields.push({ name, value: value || unknown, inline });
    };

    // Row 1 — short-term momentum, matching the reference tiles.
    push('1h', toNumber(quote.change1h) === null ? unknown : formatPercentWithArrow(quote.change1h));
    push('24h', toNumber(quote.change24h) === null ? unknown : formatPercentWithArrow(quote.change24h));
    push('7d', toNumber(quote.change7d) === null ? unknown : formatPercentWithArrow(quote.change7d));

    // Row 2 — the intraday range.
    const rangeSuffix = quote.derivedRange ? ' (est.)' : '';
    push(`24h High${rangeSuffix}`, formatPrice(quote.high24h));
    push(`24h Low${rangeSuffix}`, formatPrice(quote.low24h));
    push('Rank', toNumber(quote.rank) === null ? unknown : `#${quote.rank}`);

    // Row 3 — size and activity.
    push('Market Cap', formatCompact(quote.marketCap));
    push('Volume 24h', formatCompact(quote.volume24h));

    if (toNumber(quote.athChangePercent) !== null) {
        push('From ATH', formatPercent(quote.athChangePercent, { decimals: 1 }));
    } else if (toNumber(quote.liquidity) !== null) {
        push('Liquidity', formatCompact(quote.liquidity));
    } else {
        push('FDV', formatCompact(quote.fdv));
    }

    return fields;
}

/**
 * Profit/loss block for a hypothetical position.
 * Shows the arithmetic openly so the number is verifiable at a glance.
 */
function buildPositionField(position, quote, { label = 'Position' } = {}) {
    if (!position) {
        return null;
    }

    const verdict = position.breakEven
        ? 'BREAK EVEN'
        : position.isProfit
            ? 'PROFIT'
            : 'LOSS';

    const rows = buildAlignedRows([
        ['Invested', formatPrice(position.amount)],
        ['Entry price', formatPrice(position.entryPrice)],
        ['Now', formatPrice(position.currentPrice)],
        [`${quote.symbol || 'Tokens'} held`, formatUnits(position.units)],
        ['Value now', formatPrice(position.currentValue)],
        [verdict, `${formatSignedMoney(position.profitLoss)} (${formatPercent(position.profitLossPercent)})`],
    ]);

    return {
        name: label,
        value: `\`\`\`\n${rows}\n\`\`\``,
        inline: false,
    };
}

/** "What if you'd bought 24h ago" line. */
function buildWhatIfField(whatIf) {
    if (!whatIf) {
        return null;
    }

    const outcome = whatIf.breakEven
        ? 'would have broken even'
        : whatIf.isProfit
            ? 'would be up'
            : 'would be down';

    return {
        name: 'If bought 24h ago',
        value: `${formatPrice(whatIf.amount)} ${outcome} `
            + `**${formatSignedMoney(whatIf.profitLoss)}** `
            + `(${formatPercent(whatIf.profitLossPercent)}) — worth ${formatPrice(whatIf.currentValue)} now.`,
        inline: false,
    };
}

/**
 * Build the complete /trade embed.
 *
 * @param {object} input
 * @param {object} input.quote      Normalized quote from marketDataService.
 * @param {object|null} [input.position] Result of calculatePosition().
 * @param {object|null} [input.whatIf]   Result of calculateTwentyFourHourWhatIf().
 * @param {string|null} [input.analysis] Optional AI commentary (read-only).
 * @param {object} [input.live]     Live tracker state.
 */
export function buildTradeEmbed({
    quote,
    position = null,
    whatIf = null,
    analysis = null,
    live = null,
} = {}) {
    const direction = directionOf(quote.change24h);

    // Header and chart share one code block: two adjacent blocks would render
    // as a single stray ``` fence and break the layout.
    const blockLines = [buildHeaderBlock(quote)];

    const chart = buildChartBlock(quote);
    if (chart) {
        blockLines.push('', chart);
    }

    const sections = [`\`\`\`\n${blockLines.join('\n')}\n\`\`\``];

    const embed = createEmbed({
        title: `${displayName(quote.name)} · ${quote.symbol}`,
        description: sections.join(''),
        color: colorFor(direction),
        url: quote.pairUrl || null,
        thumbnail: quote.image || null,
        timestamp: true,
    });

    embed.addFields(buildStatFields(quote));

    const setup = scoreMemeCoin(quote);
    const positives = setup.reasons.length ? setup.reasons.join('; ') : 'no confirmed momentum alignment';
    const flags = setup.warnings.length ? setup.warnings.join('; ') : 'no extra flags from available data';
    embed.addFields({
        name: `Market setup · ${setup.score}/100 · ${setup.risk} risk`,
        value: `**Signals:** ${positives}.\n**Watch-outs:** ${flags}.\n`
            + '*A setup score ranks current statistics; it is not a prediction or buy recommendation.*',
        inline: false,
    });

    const positionField = buildPositionField(position, quote);
    if (positionField) {
        embed.addFields(positionField);
    }

    const whatIfField = buildWhatIfField(whatIf);
    if (whatIfField) {
        embed.addFields(whatIfField);
    }

    if (analysis) {
        embed.addFields({
            name: 'Market Read (AI)',
            value: `${analysis}\n\n*Analysis only — this bot never trades, holds, or moves funds.*`.slice(0, 1024),
            inline: false,
        });
    }

    // Status line lives in a field, not the footer: embeds.js patches
    // setFooter to discard any text that does not match its keyword
    // allowlist, so a footer here would be silently dropped.
    const statusParts = [SOURCE_LABELS[quote.source] || 'Market data'];

    if (quote.chain) {
        statusParts.push(String(quote.chain).toUpperCase());
    }

    if (live?.active) {
        statusParts.push(
            `Live · every ${Math.round(live.intervalMs / 1000)}s `
            + `(${live.updateCount}/${live.maxUpdates})`,
        );
    } else if (live) {
        statusParts.push('Live updates ended');
    }

    if (quote.derivedRange) {
        statusParts.push('24h range estimated');
    }

    embed.addFields({
        name: 'Source',
        value: `${statusParts.join(' · ')}\n*Read-only market data. This bot never trades or moves funds.*`.slice(0, 1024),
        inline: false,
    });

    return embed;
}

/** Buttons under the card. All are read-only actions. */
export function buildTradeButtons(sessionId, { active = true, aiEnabled = false } = {}) {
    const row = new ActionRowBuilder();

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`${TRADE_BUTTON_IDS.REFRESH}:${sessionId}`)
            .setLabel('Refresh')
            .setStyle(ButtonStyle.Secondary),
    );

    if (aiEnabled) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`${TRADE_BUTTON_IDS.ANALYZE}:${sessionId}`)
                .setLabel('AI Read')
                .setStyle(ButtonStyle.Primary),
        );
    }

    if (active) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`${TRADE_BUTTON_IDS.STOP}:${sessionId}`)
                .setLabel('Stop Live Updates')
                .setStyle(ButtonStyle.Danger),
        );
    }

    return [row];
}

/**
 * The ping line posted alongside the card.
 * Kept out of the embed on purpose: mentions inside embeds do not notify.
 */
export function buildAlertContent(userId, quote, position) {
    if (!userId) {
        return '';
    }

    const move = toNumber(quote.change24h);
    const arrow = arrowFor(move);
    const changeText = move === null ? '' : ` ${arrow} ${formatPercent(move)} 24h`;

    let line = `<@${userId}> ${quote.symbol} ${formatPrice(quote.price)}${changeText}`;

    if (position) {
        line += ` · ${position.isProfit ? 'up' : position.breakEven ? 'flat' : 'down'} `
            + `${formatSignedMoney(position.profitLoss)}`;
    }

    return line.slice(0, 2000);
}

export const __testables = {
    buildHeaderBlock,
    buildChartBlock,
    buildStatFields,
    buildPositionField,
    buildWhatIfField,
    discordRelative,
};

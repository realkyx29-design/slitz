import { getColor } from '../../config/bot.js';
import { createEmbed } from '../../utils/embeds.js';
import { formatCompact, formatPercent, formatPrice } from '../../utils/tradeFormat.js';

function coinLine(coin, index, { showScore = true } = {}) {
    const identity = coin.url
        ? `**${index + 1}. [${coin.symbol}](${coin.url})**`
        : `**${index + 1}. ${coin.symbol}**`;
    const score = showScore ? ` · setup **${coin.score}/100**` : '';
    return `${identity} · ${formatPrice(coin.price)} · ${formatPercent(coin.change24h)}${score}`
        + `\nVol ${formatCompact(coin.volume24h)} · Cap ${formatCompact(coin.marketCap)} · Risk: ${coin.risk}`;
}

export function buildMemeScanEmbed(scan) {
    const best = scan.setups.slice(0, 5);
    const movers = scan.movers.slice(0, 5);
    const embed = createEmbed({
        title: 'Memecoin Market Radar',
        description: [
            `Scanned **${scan.scanned}** category-listed coins; **${scan.active}** passed minimum activity filters.`,
            'This ranks current data quality and momentum—not future returns or “safe buys.”',
        ].join('\n'),
        color: getColor('primary', '#5865F2'),
        timestamp: true,
    });

    embed.addFields({
        name: 'Balanced setups to research',
        value: best.length
            ? best.map((coin, index) => coinLine(coin, index)).join('\n\n').slice(0, 1024)
            : 'No coins passed the activity and data-quality filters right now.',
        inline: false,
    });

    embed.addFields({
        name: 'Fastest 24h movers',
        value: movers.length
            ? movers.map((coin, index) => coinLine(coin, index, { showScore: false })).join('\n\n').slice(0, 1024)
            : 'No positive 24h movers passed the filters right now.',
        inline: false,
    });

    if (best[0]) {
        const signals = best[0].reasons.length ? best[0].reasons.join('; ') : 'no strong confirmation signals';
        const warnings = best[0].warnings.length ? best[0].warnings.join('; ') : 'no extra flags from available data';
        embed.addFields({
            name: `Why ${best[0].symbol} ranked highest`,
            value: `Signals: ${signals}.\nWatch-outs: ${warnings}.`,
            inline: false,
        });
    }

    embed.addFields({
        name: 'How to read this',
        value: `${scan.methodology}.\n`
            + `Coverage: ${scan.source}; this is broad but cannot include every newly created on-chain token. `
            + 'Verify the contract, holder concentration, liquidity lock, taxes, and audit before risking funds. '
            + '**Memecoins can go to zero. This is market research, not financial advice.**',
        inline: false,
    });

    return embed;
}

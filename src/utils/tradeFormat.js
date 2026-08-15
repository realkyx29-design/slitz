// tradeFormat.js — pure formatting helpers for the /trade market card.
//
// Everything in this file is side-effect free and dependency free so it can be
// unit tested directly (see test/tradeFormat.test.js).
//
// Memecoin prices routinely look like 0.000000002392, which JavaScript happily
// renders as "2.392e-9". Discord users should never see scientific notation, so
// tiny prices are rendered with the subscript-zero convention used by
// DexScreener / CoinGecko: $0.0₈2392.

const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/** Characters used to draw the 7d sparkline. Ordered low -> high. */
export const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export const ARROW_UP = '▲';
export const ARROW_DOWN = '▼';
export const ARROW_FLAT = '▬';

/** True when `value` is a usable, finite number. */
export function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Coerce API values (which may arrive as strings) into a finite number or null. */
export function toNumber(value) {
    if (isFiniteNumber(value)) {
        return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function toSubscript(count) {
    return String(count)
        .split('')
        .map((digit) => SUBSCRIPT_DIGITS[Number(digit)] ?? '')
        .join('');
}

function withThousands(value) {
    const [whole, decimals] = String(value).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decimals ? `${grouped}.${decimals}` : grouped;
}

/**
 * Format a USD price without ever falling back to scientific notation.
 *
 * Large prices get thousands separators, ordinary prices get 2-6 decimals, and
 * sub-0.0001 prices get the subscript-zero treatment with 4 significant digits.
 */
export function formatPrice(price, { currency = '$' } = {}) {
    const value = toNumber(price);

    if (value === null) {
        return '—';
    }

    if (value === 0) {
        return `${currency}0.00`;
    }

    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);

    if (abs >= 1000) {
        return `${sign}${currency}${withThousands(abs.toFixed(2))}`;
    }

    if (abs >= 1) {
        return `${sign}${currency}${withThousands(abs.toFixed(2))}`;
    }

    if (abs >= 0.01) {
        return `${sign}${currency}${abs.toFixed(4)}`;
    }

    if (abs >= 0.0001) {
        return `${sign}${currency}${abs.toFixed(6)}`;
    }

    // Sub-0.0001: render as 0.0<subscript zero count><4 significant digits>.
    let exponent = Math.floor(Math.log10(abs));
    let mantissa = abs / (10 ** exponent);

    // Guard against floating point pushing the mantissa to 10.000 after rounding
    // (e.g. 9.9999e-7 -> "10.000"), which would render one zero too many.
    let digits = mantissa.toFixed(3);
    if (Number(digits) >= 10) {
        exponent += 1;
        mantissa = abs / (10 ** exponent);
        digits = mantissa.toFixed(3);
    }

    const zeros = Math.max(0, -exponent - 1);
    const significant = digits.replace('.', '');

    return `${sign}${currency}0.0${toSubscript(zeros)}${significant}`;
}

/** Compact money formatting: $43.77B, $1.08B, $912.4K. */
export function formatCompact(value, { currency = '$' } = {}) {
    const number = toNumber(value);

    if (number === null) {
        return '—';
    }

    const sign = number < 0 ? '-' : '';
    const abs = Math.abs(number);

    const units = [
        { limit: 1e12, suffix: 'T' },
        { limit: 1e9, suffix: 'B' },
        { limit: 1e6, suffix: 'M' },
        { limit: 1e3, suffix: 'K' },
    ];

    for (const { limit, suffix } of units) {
        if (abs >= limit) {
            const scaled = abs / limit;
            const decimals = scaled >= 100 ? 1 : 2;
            return `${sign}${currency}${scaled.toFixed(decimals)}${suffix}`;
        }
    }

    return `${sign}${currency}${abs.toFixed(2)}`;
}

/** Plain integer with thousands separators (token unit counts). */
export function formatUnits(value) {
    const number = toNumber(value);

    if (number === null) {
        return '—';
    }

    const abs = Math.abs(number);
    // Huge memecoin unit counts read better without decimals.
    const decimals = abs >= 1000 ? 0 : abs >= 1 ? 2 : 6;

    return withThousands(number.toFixed(decimals));
}

/** Signed percentage, always with an explicit + or - sign. */
export function formatPercent(value, { decimals = 2 } = {}) {
    const number = toNumber(value);

    if (number === null) {
        return '—';
    }

    const sign = number > 0 ? '+' : number < 0 ? '-' : '';
    return `${sign}${Math.abs(number).toFixed(decimals)}%`;
}

/** Signed money value, always with an explicit + or - sign. */
export function formatSignedMoney(value, { currency = '$' } = {}) {
    const number = toNumber(value);

    if (number === null) {
        return '—';
    }

    const sign = number > 0 ? '+' : number < 0 ? '-' : '';
    const abs = Math.abs(number);
    const body = abs >= 1000
        ? withThousands(abs.toFixed(2))
        : abs >= 0.01 || abs === 0
            ? abs.toFixed(2)
            : formatPrice(abs, { currency: '' });

    return `${sign}${currency}${body}`;
}

/** Direction of a change: 'up' | 'down' | 'flat' (null input counts as flat). */
export function directionOf(value) {
    const number = toNumber(value);

    if (number === null || number === 0) {
        return 'flat';
    }

    return number > 0 ? 'up' : 'down';
}

/** Arrow glyph matching a direction. Survives the embed emoji sanitizer. */
export function arrowFor(value) {
    const direction = directionOf(value);

    if (direction === 'up') {
        return ARROW_UP;
    }

    if (direction === 'down') {
        return ARROW_DOWN;
    }

    return ARROW_FLAT;
}

/** Percentage with a leading direction arrow, e.g. "▼ -1.40%". */
export function formatPercentWithArrow(value, options = {}) {
    if (toNumber(value) === null) {
        return '—';
    }

    return `${arrowFor(value)} ${formatPercent(value, options)}`;
}

/**
 * Render a price series as a block sparkline.
 * A flat series renders as a mid-height line rather than dividing by zero.
 */
export function buildSparkline(series, { width = 28 } = {}) {
    if (!Array.isArray(series)) {
        return '';
    }

    const points = series.map(toNumber).filter((value) => value !== null);

    if (points.length < 2) {
        return '';
    }

    // Downsample to `width` buckets by averaging, so the shape survives.
    const buckets = [];
    const bucketSize = points.length / width;

    for (let index = 0; index < width; index += 1) {
        const start = Math.floor(index * bucketSize);
        const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
        const slice = points.slice(start, Math.min(end, points.length));

        if (slice.length === 0) {
            continue;
        }

        buckets.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
    }

    if (buckets.length < 2) {
        return '';
    }

    const min = Math.min(...buckets);
    const max = Math.max(...buckets);
    const range = max - min;

    if (range === 0) {
        return SPARK_CHARS[3].repeat(buckets.length);
    }

    return buckets
        .map((value) => {
            const ratio = (value - min) / range;
            const index = Math.min(
                SPARK_CHARS.length - 1,
                Math.max(0, Math.round(ratio * (SPARK_CHARS.length - 1))),
            );
            return SPARK_CHARS[index];
        })
        .join('');
}

/**
 * Padding character for aligned columns.
 *
 * src/utils/embeds.js sanitizes every title, description and field through a
 * regex that collapses runs of ASCII spaces/tabs to a single space and strips
 * spaces adjacent to newlines. That would destroy any column alignment built
 * with normal spaces, so we pad with a non-breaking space, which the sanitizer
 * leaves untouched and which renders at the same width in Discord's monospace
 * font.
 */
export const PAD = '\u00A0';

/** Pad `text` to `width` using non-breaking spaces (sanitizer-safe). */
export function padTo(text, width) {
    const str = String(text);
    return str.length >= width ? str : str + PAD.repeat(width - str.length);
}

/** Label/value rows aligned into two columns for a monospace code block. */
export function buildAlignedRows(rows, { gap = 2 } = {}) {
    const usable = rows.filter((row) => Array.isArray(row) && row.length >= 2);

    if (usable.length === 0) {
        return '';
    }

    // Pad every column except the last so any row width aligns. Two-column
    // input behaves exactly as before.
    const columnCount = Math.max(...usable.map((row) => row.length));
    const widths = [];

    for (let column = 0; column < columnCount - 1; column += 1) {
        widths.push(Math.max(...usable.map((row) => String(row[column] ?? '').length)));
    }

    return usable
        .map((row) => row
            .map((cell, column) => {
                const text = String(cell ?? '');
                return column === columnCount - 1
                    ? text
                    : padTo(text, widths[column] + gap);
            })
            .join(''))
        .join('\n');
}

/** Discord relative timestamp, e.g. <t:1700000000:R>. */
export function discordRelative(timestampMs) {
    const value = toNumber(timestampMs);

    if (value === null) {
        return '';
    }

    return `<t:${Math.floor(value / 1000)}:R>`;
}

/** Uppercase, whitespace-collapsed display name. */
export function displayName(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .trim();
}

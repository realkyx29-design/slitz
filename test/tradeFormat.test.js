import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    ARROW_DOWN,
    ARROW_FLAT,
    ARROW_UP,
    buildAlignedRows,
    buildSparkline,
    directionOf,
    formatCompact,
    formatPercent,
    formatPrice,
    formatSignedMoney,
    formatUnits,
    PAD,
    toNumber,
} = await import('../src/utils/tradeFormat.js');

test('toNumber coerces strings and rejects junk', () => {
    assert.equal(toNumber('0.00002392'), 0.00002392);
    assert.equal(toNumber(2.39e-6), 2.39e-6);
    assert.equal(toNumber('1,234'), null);
    assert.equal(toNumber(''), null);
    assert.equal(toNumber(null), null);
    assert.equal(toNumber(Infinity), null);
    assert.equal(toNumber(NaN), null);
});

test('formatPrice never emits scientific notation for tiny memecoin prices', () => {
    const tiny = formatPrice(2.39e-6);
    assert.ok(!/e-/i.test(tiny), `expected no exponent, got ${tiny}`);
    assert.equal(tiny, '$0.0₅2390');

    const tinier = formatPrice(1e-12);
    assert.ok(!/e-/i.test(tinier), `expected no exponent, got ${tinier}`);
});

test('formatPrice scales precision to magnitude', () => {
    assert.equal(formatPrice(75.11), '$75.11');
    assert.equal(formatPrice(1234.5), '$1,234.50');
    assert.equal(formatPrice(0.5), '$0.5000');
    assert.equal(formatPrice(0), '$0.00');
    assert.equal(formatPrice(null), '—');
    assert.equal(formatPrice(-75.11), '-$75.11');
});

test('formatCompact abbreviates large values', () => {
    assert.equal(formatCompact(1.08e9), '$1.08B');
    assert.equal(formatCompact(43.77e9), '$43.77B');
    assert.equal(formatCompact(12345678), '$12.35M');
    assert.equal(formatCompact(1234), '$1.23K');
    assert.equal(formatCompact(null), '—');
});

test('direction and arrows handle up, down and flat', () => {
    assert.equal(directionOf(1.4), 'up');
    assert.equal(directionOf(-1.4), 'down');
    assert.equal(directionOf(0), 'flat');
    assert.equal(directionOf(null), 'flat');

    assert.equal(formatPercent(1.4), '+1.40%');
    assert.equal(formatPercent(-1.4), '-1.40%');
    assert.equal(formatPercent(0), '0.00%');
});

test('arrow glyphs survive the embed emoji sanitizer', async () => {
    // embeds.js strips Extended_Pictographic; geometric shapes must not match.
    const EMOJI_REGEX = /[\p{Extended_Pictographic}\uFE0F]/gu;

    for (const glyph of [ARROW_UP, ARROW_DOWN, ARROW_FLAT, '▁', '█', '₅']) {
        assert.equal(glyph.replace(EMOJI_REGEX, ''), glyph, `${glyph} was stripped`);
    }
});

test('formatSignedMoney always carries an explicit sign', () => {
    assert.equal(formatSignedMoney(251.83), '+$251.83');
    assert.equal(formatSignedMoney(-165.44), '-$165.44');
    // Exactly break-even is neither a gain nor a loss, so it carries no sign.
    assert.equal(formatSignedMoney(0), '$0.00');
});

test('formatUnits keeps tiny and huge token counts readable', () => {
    assert.ok(!/e\+/i.test(formatUnits(25_000_000)));
    assert.equal(typeof formatUnits(16.666), 'string');
});

test('buildSparkline renders a fixed-width bar chart', () => {
    const rising = Array.from({ length: 168 }, (_, i) => i);
    const line = buildSparkline(rising, { width: 30 });

    assert.equal(line.length, 30);
    assert.equal(line[0], '▁');
    assert.equal(line[line.length - 1], '█');

    // A flat series must not divide by zero.
    const flat = buildSparkline(new Array(50).fill(5), { width: 10 });
    assert.equal(flat.length, 10);

    assert.equal(buildSparkline([], { width: 10 }), '');
    assert.equal(buildSparkline(null, { width: 10 }), '');
});

test('buildAlignedRows pads with non-breaking spaces so alignment survives sanitizing', () => {
    const rows = buildAlignedRows([
        ['Invested', '$1,000.00'],
        ['Entry price', '$60.00'],
    ]);

    assert.ok(rows.includes(PAD), 'expected non-breaking padding');

    // The sanitizer collapses ASCII space runs; NBSP padding must survive it.
    const sanitized = rows.replace(/[ \t]+/g, ' ');
    assert.equal(sanitized, rows, 'alignment was destroyed by space collapsing');

    const [first, second] = rows.split('\n');
    assert.equal(first.indexOf('$1,000.00'), second.indexOf('$60.00'));
});

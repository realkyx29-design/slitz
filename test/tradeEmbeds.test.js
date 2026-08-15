import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/titanbot';

const {
    buildSignalButtons,
    buildSignalContent,
    buildSignalEmbed,
    buildSimulateEmbed,
    buildTrendingEmbed,
    buildWatchAddEmbed,
    buildWatchListEmbed,
    TRADE_BUTTON_IDS,
} = await import('../src/services/trading/tradeEmbed.js');

const NOTIFY_ID = '1377402826514235442';

const signal = {
    primary: {
        id: 'bonk',
        name: 'Bonk',
        symbol: 'BONK',
        source: 'coingecko',
        price: 2.39e-5,
        change1h: 3.1,
        change24h: 18.4,
        change7d: 22,
        marketCap: 210e6,
        volume24h: 45e6,
        score: 78,
        risk: 'High',
        reasons: ['1h and 24h momentum agree'],
        warnings: [],
        sparkline: [],
    },
    candidates: [{ id: 'pepe', symbol: 'PEPE', price: 1.1e-5, change24h: 6.2, score: 66 }],
    stake: { amount: 150, multiplier: 0.75, reason: 'established mid-cap' },
    scenarios: [
        { label: 'Repeats today', multiplier: 1.184, value: 177.6, profit: 27.6 },
        { label: '2x', multiplier: 2, value: 300, profit: 150 },
    ],
    budget: 200,
    generatedAt: Date.now(),
    source: 'test-scan',
};

test('signal content pings exactly the configured user and carries the headline math', () => {
    const content = buildSignalContent(NOTIFY_ID, signal);

    assert.ok(content.includes(`<@${NOTIFY_ID}>`), 'must ping the configured user');
    assert.ok(content.includes('BONK'), 'names the coin');
    assert.ok(content.includes('$177.60'), 'shows the projected value');
    assert.ok(content.includes('+$27.60'), 'shows the projected profit');
    assert.ok(!content.includes('@everyone'), 'never pings everyone');
    assert.ok(content.length <= 2000, 'fits a message');
});

test('signal content degrades to empty without a user or signal', () => {
    assert.equal(buildSignalContent(null, signal), '');
    assert.equal(buildSignalContent(NOTIFY_ID, null), '');
});

test('signal embed surfaces sizing, scenarios and the runners-up', () => {
    const embed = buildSignalEmbed({ signal });
    const data = embed.toJSON();

    assert.match(data.title, /Momentum Signal/);
    const names = data.fields.map((f) => f.name);

    assert.ok(names.some((n) => n.includes('Why this coin was flagged')));
    assert.ok(names.some((n) => n.includes('Hypothetical entry')));
    assert.ok(names.some((n) => n.includes('If you put in')));
    assert.ok(names.some((n) => n.includes('Also heading up')));

    const sizing = data.fields.find((f) => f.name.includes('Hypothetical entry'));
    assert.ok(sizing.name.includes('$150.00'), 'shows the sized stake');
    assert.ok(sizing.value.includes('what-if'), 'keeps the hypothetical framing');

    const scenarioField = data.fields.find((f) => f.name.includes('If you put in'));
    assert.ok(scenarioField.value.includes('$177.60'), 'scenario table renders values');
});

test('signal buttons carry a trackable custom id, guarded to 100 chars', () => {
    const [row] = buildSignalButtons('bonk', 150);
    const customId = row.toJSON().components[0].custom_id;

    assert.equal(customId, `${TRADE_BUTTON_IDS.TRACK}:bonk:150`);

    // An absurdly long coin id must fall back to no buttons, not a rejected payload.
    const overflow = buildSignalButtons('x'.repeat(200), 150);
    assert.deepEqual(overflow, []);
});

test('simulate embed renders the ladder and keeps the read-only framing', () => {
    const quote = {
        id: 'bonk', name: 'Bonk', symbol: 'BONK', source: 'coingecko',
        price: 2.39e-5, change24h: 18.4, sparkline: [],
    };
    const scenarios = [
        { label: '2x', multiplier: 2, value: 200, profit: 100 },
        { label: '10x', multiplier: 10, value: 1000, profit: 900 },
    ];

    const embed = buildSimulateEmbed({ quote, amount: 100, scenarios, whatIf: null });
    const data = embed.toJSON();

    assert.match(data.title, /What-If Ladder/);
    const ladder = data.fields.find((f) => f.name.includes('If the price moves'));
    assert.ok(ladder.value.includes('$200.00'));
    assert.ok(ladder.value.includes('+$900.00'), 'profit column is present');

    const source = data.fields.find((f) => f.name === 'Source');
    assert.ok(/never trades/i.test(source.value), 'read-only disclaimer present');
});

test('trending embed labels risk and warns about boosted visibility', () => {
    const trending = {
        entries: [{
            quote: { symbol: 'NEW', price: 0.001, change24h: 40, volume24h: 500_000, liquidity: 120_000 },
            chain: 'Solana',
            risk: 'Very high',
            url: 'https://dexscreener.com/solana/x',
        }],
        scanned: 1,
        source: 'DexScreener top boosts',
    };

    const data = buildTrendingEmbed(trending).toJSON();
    const board = data.fields.find((f) => f.name === 'Boosted tokens');

    assert.ok(board.value.includes('NEW'));
    assert.ok(board.value.includes('Very high'), 'risk label is shown');

    const warning = data.fields.find((f) => f.name === 'Read this first');
    assert.ok(/not financial advice/i.test(warning.value));
});

test('watch add embed shows target, distance and the one-shot note', () => {
    const quote = { symbol: 'BONK', price: 0.00002, image: null };
    const alert = { symbol: 'BONK', targetPrice: 0.00003, direction: 'above' };

    const data = buildWatchAddEmbed({ quote, alert }).toJSON();

    assert.match(data.title, /Price Alert Set/);
    assert.ok(data.description.includes('above'));
    const distance = data.fields.find((f) => f.name === 'Distance');
    assert.equal(distance.value, '+50.00%');
});

test('watch list embed handles the empty state', () => {
    const data = buildWatchListEmbed([]).toJSON();
    assert.match(data.description, /no active alerts/i);
});

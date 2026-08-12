import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const {
    LOG_DESTINATIONS,
    TICKET_LOG_DESTINATIONS,
    ALL_LOG_DESTINATIONS,
} = await import('../src/services/loggingService.js');

const { normalizeGuildConfig } = await import('../src/utils/schemas.js');

const { DESTINATION_CONFIG_KEYS } = await import('../src/utils/ticket/ticketLogging.js');

// ---------------------------------------------------------------------------
// /logging channel destinations
// ---------------------------------------------------------------------------

test('ticket destinations are exposed alongside the classic ones', () => {
    assert.deepEqual(LOG_DESTINATIONS, ['audit', 'applications', 'reports']);
    assert.deepEqual(Object.keys(TICKET_LOG_DESTINATIONS), [
        'ticket-events',
        'ticket-transcripts',
        'ticket-ai',
    ]);
    assert.deepEqual(ALL_LOG_DESTINATIONS, [
        'audit',
        'applications',
        'reports',
        'ticket-events',
        'ticket-transcripts',
        'ticket-ai',
    ]);
});

test('every ticket destination maps to a real guild-config key', () => {
    const knownKeys = new Set(Object.values(DESTINATION_CONFIG_KEYS ?? {}));
    for (const configKey of Object.values(TICKET_LOG_DESTINATIONS)) {
        assert.ok(
            knownKeys.has(configKey),
            `${configKey} is not a destination key ticket logging reads from`,
        );
    }
});

test('the slash command offers exactly the supported destinations', async () => {
    const command = (await import('../src/commands/Logging/logging.js')).default;
    const json = command.data.toJSON();
    const channelSub = json.options.find((option) => option.name === 'channel');
    const destination = channelSub.options.find((option) => option.name === 'destination');

    assert.deepEqual(
        destination.choices.map((choice) => choice.value),
        ALL_LOG_DESTINATIONS,
    );
});

test('every destination has a human-readable label', async () => {
    const { promises: fs } = await import('node:fs');
    const source = await fs.readFile(
        new URL('../src/commands/Logging/modules/logging_channel.js', import.meta.url),
        'utf8',
    );

    for (const destination of ALL_LOG_DESTINATIONS) {
        assert.ok(
            source.includes(`'${destination}'`) || new RegExp(`\\b${destination}:`).test(source),
            `missing label for ${destination}`,
        );
    }
});

// ---------------------------------------------------------------------------
// Legacy ticketLogging.* migration
// ---------------------------------------------------------------------------

test('legacy nested ticketLogging channels are lifted to the canonical keys', () => {
    const normalized = normalizeGuildConfig({
        ticketLogging: {
            lifecycleChannelId: '111',
            transcriptChannelId: '222',
            aiLogsChannelId: '333',
        },
    });

    assert.equal(normalized.ticketLogsChannelId, '111');
    assert.equal(normalized.ticketTranscriptChannelId, '222');
    assert.equal(normalized.ticketAiLogsChannelId, '333');
    assert.equal(normalized.ticketLogging, undefined);
});

test('canonical top-level keys win over the legacy block', () => {
    const normalized = normalizeGuildConfig({
        ticketLogsChannelId: 'canonical',
        ticketLogging: { lifecycleChannelId: 'legacy' },
    });

    assert.equal(normalized.ticketLogsChannelId, 'canonical');
    assert.equal(normalized.ticketLogging, undefined);
});

test('configs without the legacy block are untouched', () => {
    const normalized = normalizeGuildConfig({ ticketLogsChannelId: '999' });

    assert.equal(normalized.ticketLogsChannelId, '999');
    assert.equal(normalized.ticketTranscriptChannelId ?? null, null);
    assert.equal(normalized.ticketLogging, undefined);
});

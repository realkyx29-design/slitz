import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const { extractPinnedTicketMessages } = await import('../src/services/ticket.js');

test('extractPinnedTicketMessages supports the current discord.js paginated response', () => {
    const panel = { id: 'panel-1', createdTimestamp: 100 };
    const banner = { id: 'banner-1', createdTimestamp: 200 };

    assert.deepEqual(
        extractPinnedTicketMessages({
            items: [
                { message: panel, pinnedTimestamp: 100 },
                { message: banner, pinnedTimestamp: 200 },
            ],
            hasMore: false,
        }),
        [panel, banner],
    );
});

test('extractPinnedTicketMessages remains compatible with collection and array responses', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    const collection = new Map([[first.id, first], [second.id, second]]);

    assert.deepEqual(extractPinnedTicketMessages(collection), [first, second]);
    assert.deepEqual(extractPinnedTicketMessages([first, second]), [first, second]);
    assert.deepEqual(extractPinnedTicketMessages(null), []);
});

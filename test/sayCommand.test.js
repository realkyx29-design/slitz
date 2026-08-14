import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const {
    default: sayCommand,
    isImageAttachment,
    sanitizeSayMessage,
} = await import('../src/commands/Moderation/say.js');

test('/say accepts an optional image and permits image-only messages', () => {
    const data = sayCommand.data.toJSON();
    const message = data.options.find((option) => option.name === 'message');
    const image = data.options.find((option) => option.name === 'image');

    assert.equal(message.required, false);
    assert.equal(image.required, false);
    assert.equal(image.type, 11);
});

test('say messages preserve Markdown line breaks and blank lines', () => {
    const message = [
        '**1.** First rule',
        '',
        '**2.** Second rule',
        '',
        '-# Rules may change',
    ].join('\r\n');

    assert.equal(
        sanitizeSayMessage(`\n${message}\n`),
        '**1.** First rule\n\n**2.** Second rule\n\n-# Rules may change',
    );
});

test('say message sanitization removes unsafe controls without flattening text', () => {
    assert.equal(sanitizeSayMessage('First\u0000 line\nSecond\tline'), 'First line\nSecond\tline');
    assert.equal(sanitizeSayMessage(null), '');
});

test('say image validation accepts image MIME types', () => {
    assert.equal(isImageAttachment({ name: 'photo.bin', contentType: 'image/png' }), true);
    assert.equal(isImageAttachment({ name: 'photo.PNG', contentType: null }), true);
});

test('say image validation rejects non-image attachments', () => {
    assert.equal(isImageAttachment({ name: 'notes.txt', contentType: 'text/plain' }), false);
    assert.equal(isImageAttachment({ name: 'renamed.png', contentType: 'application/pdf' }), false);
    assert.equal(isImageAttachment(null), false);
});

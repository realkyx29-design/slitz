import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const { buildHoneypotEmbed, normalizeHoneypotConfig, DEFAULT_HONEYPOT_CONFIG } = await import('../src/services/honeypotService.js');
const { normalizeGuildConfig } = await import('../src/utils/schemas.js');

const guild = {
  id: '111222333444555666',
  members: { me: { displayAvatarURL: () => 'https://cdn.example.com/bot-avatar.png' } },
};
const client = { user: { displayAvatarURL: () => 'https://cdn.example.com/bot-avatar.png' } };

test('normalizeHoneypotConfig fills every default', () => {
  const config = normalizeHoneypotConfig({});
  assert.deepEqual(config, {
    ...DEFAULT_HONEYPOT_CONFIG,
    heading: ['DO NOT SEND', 'MESSAGES IN THIS', 'CHANNEL'],
    description: 'This channel is used to catch spam bots. Any messages sent here will result in a **softban.**',
    counterLabel: 'Kicks',
    color: '#2F3136',
  });
});

test('normalizeGuildConfig exposes honeypot defaults', () => {
  const normalized = normalizeGuildConfig({}, {});
  assert.equal(normalized.honeypot.enabled, false);
  assert.deepEqual(normalized.honeypot.heading, ['DO NOT SEND', 'MESSAGES IN THIS', 'CHANNEL']);
  assert.equal(normalized.honeypot.kicks, 0);
});

test('default embed matches the reference style', () => {
  const embed = buildHoneypotEmbed({ honeypot: {}, guild, client });
  const data = embed.toJSON();

  assert.equal(data.title, 'DO NOT SEND\nMESSAGES IN THIS\nCHANNEL');
  assert.equal(
    data.description,
    'This channel is used to catch spam bots. Any messages sent here will result in a **softban.**',
  );
  assert.equal(data.color, 0x2f3136);
  assert.equal(data.author.name, '⚠️');
  assert.equal(data.author.icon_url, 'https://cdn.example.com/bot-avatar.png');
  assert.equal(data.footer.text, 'Kicks: 0');
});

test('custom text and kick counter are reflected in the embed', () => {
  const honeypot = {
    heading: ['STAY OUT', 'OF THIS', 'CHANNEL'],
    description: 'Custom description.',
    counterLabel: 'Softbans',
    kicks: 7,
    icon: '🚨',
    color: '#ED4245',
  };
  const embed = buildHoneypotEmbed({ honeypot, guild, client });
  const data = embed.toJSON();

  assert.equal(data.title, 'STAY OUT\nOF THIS\nCHANNEL');
  assert.equal(data.description, 'Custom description.');
  assert.equal(data.color, 0xed4245);
  assert.equal(data.author.name, '🚨');
  assert.equal(data.footer.text, 'Softbans: 7');
});

test('image URL icon is used as the author logo', () => {
  const embed = buildHoneypotEmbed({
    honeypot: { icon: 'https://cdn.example.com/shield.png' },
    guild,
    client,
  });
  const data = embed.toJSON();

  assert.equal(data.author.name, 'Honeypot');
  assert.equal(data.author.icon_url, 'https://cdn.example.com/shield.png');
});

test('custom description is sanitized of leading/trailing whitespace only', () => {
  const embed = buildHoneypotEmbed({
    honeypot: { description: '  Only bots fall for this.  ' },
    guild,
    client,
  });
  assert.equal(embed.toJSON().description, 'Only bots fall for this.');
});

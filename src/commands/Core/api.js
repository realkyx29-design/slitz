import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getApiStatusMonitor } from '../../services/apiStatusMonitor.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

const REFRESH_ID = 'api:refresh';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = path.resolve(__dirname, '../../../public/status-banner.png');
const BANNER_NAME = 'slitz-status-banner.png';

const COLORS = Object.freeze({
  operational: 0x35d98b,
  degraded: 0xffb547,
  outage: 0xff6473,
});

function refreshRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(REFRESH_ID)
      .setLabel('Refresh now')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

function formatService(service) {
  const ping = service.pingMs === null ? service.label : `Ping: **${service.pingMs}ms**`;
  return `${service.indicator} **${service.name}** — ${ping}\n> ${service.message}`;
}

function overallHeading(overall) {
  if (overall === 'operational') return '✅ **All systems operational**';
  if (overall === 'degraded') return '🚦 **Some services are experiencing issues**';
  return '❌ **One or more services are unavailable**';
}

function imageEmbed(overall = 'degraded') {
  return new EmbedBuilder()
    .setColor(COLORS[overall] ?? COLORS.degraded)
    .setImage(`attachment://${BANNER_NAME}`);
}

/** Build the shared Discord view without duplicating any status decisions. */
export function buildStatusPayload(snapshot, { includeBanner = true } = {}) {
  const checkedAt = Math.floor(new Date(snapshot.checkedAt).getTime() / 1_000);
  const content = [
    overallHeading(snapshot.summary.overall),
    '',
    ...snapshot.services.flatMap((service, index) => [
      formatService(service),
      ...(index < snapshot.services.length - 1 ? [''] : []),
    ]),
    '',
    `-# Last checked <t:${checkedAt}:R> • The web status page refreshes automatically every 30 seconds.`,
  ].join('\n');

  return {
    content,
    embeds: [imageEmbed(snapshot.summary.overall)],
    components: [refreshRow(false)],
    ...(includeBanner ? {
      files: [{ attachment: BANNER_PATH, name: BANNER_NAME }],
      attachments: [],
    } : {}),
  };
}

export function buildUnavailablePayload({ includeBanner = true } = {}) {
  return {
    content: '🚦 **Live status is temporarily unavailable**\n> No individual service has been marked offline. Please retry in a moment.',
    embeds: [imageEmbed('degraded')],
    components: [refreshRow(false)],
    ...(includeBanner ? {
      files: [{ attachment: BANNER_PATH, name: BANNER_NAME }],
      attachments: [],
    } : {}),
  };
}

async function statusPayload(client, { force = false } = {}) {
  const snapshot = await getApiStatusMonitor(client).getSnapshot({ force });
  return buildStatusPayload(snapshot);
}

export async function refreshStatusInteraction(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (error) {
    logger.warn('API status refresh could not be acknowledged:', error?.message);
    return;
  }

  try {
    await interaction.editReply(await statusPayload(interaction.client, { force: true }));
  } catch (error) {
    logger.error('API status refresh failed:', error);
    await interaction.editReply(buildUnavailablePayload()).catch(() => {});
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('api')
    .setDescription('Check the live status of the bot and connected third-party APIs'),

  async prefixExecute(interaction) {
    try {
      const pendingMessage = await interaction.reply({ content: 'Checking API status…' });
      const payload = await statusPayload(interaction.client);
      await pendingMessage.edit(payload);
    } catch (error) {
      logger.error('API prefix command failed:', error);
      await interaction.channel?.send(buildUnavailablePayload()).catch(() => {});
    }
  },

  async execute(interaction) {
    if (interaction.isButton?.() && interaction.customId === REFRESH_ID) {
      await refreshStatusInteraction(interaction);
      return;
    }

    const deferred = await InteractionHelper.safeDefer(interaction, {});
    if (!deferred) return;

    try {
      await InteractionHelper.safeEditReply(interaction, await statusPayload(interaction.client));
    } catch (error) {
      logger.error('API command failed:', error);
      await InteractionHelper.safeEditReply(interaction, buildUnavailablePayload());
    }
  },
};

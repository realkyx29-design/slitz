import {
  SlashCommandBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';
import { createEmbed, formatDuration } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { checkAllServices } from '../../utils/statusChecker.js';
import pkg from '../../../package.json' with { type: 'json' };

// Button custom id for refresh. Colon-split so the generic dispatcher in
// interactionCreate.js routes this through client.buttons correctly.
const REFRESH_ID = 'api:refresh';

// Width used to pad names inside the probes code block so the latencies line up.
const PROBES_NAME_WIDTH = 18;

function buildRefreshButton(disabled = false) {
  const btn = new ButtonBuilder()
    .setCustomId(REFRESH_ID)
    .setLabel('Refresh Status')
    .setStyle(ButtonStyle.Secondary);
  // Note: setEmoji is intentionally not used with a Unicode emoji because the
  // sanitizer strips them from button labels; the text label is enough.
  if (disabled) btn.setDisabled(true);
  return new ActionRowBuilder().addComponents(btn);
}

/**
 * Convert an overall status to the headline banner text shown at the top of the
 * embed, styled after the reference screenshot ("[+] All systems operational").
 * ASCII markers are used because the embed sanitizer strips Unicode emojis.
 */
function overallHeadline(overall) {
  switch (overall.status) {
    case 'online':  return '**[+] All systems operational**';
    case 'issues':  return '**[!] Some services are experiencing issues**';
    case 'offline': return '**[X] One or more services are offline**';
    default:        return '**[?] Service status unknown**';
  }
}

/**
 * Pick an ANSI foreground color for a given status, used inside the monospace
 * probes block (Discord supports ANSI inside ```ansi fences).
 */
function statusAnsi(status) {
  switch (status) {
    case 'online':  return '\x1b[32m'; // green
    case 'issues':  return '\x1b[33m'; // yellow
    case 'offline': return '\x1b[31m'; // red
    default:        return '\x1b[90m'; // gray
  }
}

const ANSI_RESET = '\x1b[0m';

function statusGlyph(status) {
  switch (status) {
    case 'online':  return '+';    // green "+" (online marker)
    case 'issues':  return '!';    // yellow "!" (warning)
    case 'offline': return 'X';    // red "X" (offline)
    default:        return '?';
  }
}

function statusLabelInline(status) {
  switch (status) {
    case 'online':  return 'Online';
    case 'issues':  return 'Issues';
    case 'offline': return 'Offline';
    default:        return 'Unknown';
  }
}

function padRight(str, width) {
  // str is plain ASCII-ish text, so String.length is good enough.
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

function buildProbesBlock(services) {
  const lines = [];
  const headerName = padRight('Service', PROBES_NAME_WIDTH);
  const header = `${headerName}   Latency`;
  lines.push(header);
  lines.push('─'.repeat(header.length));

  for (const s of services) {
    const color = statusAnsi(s.status);
    const glyph = statusGlyph(s.status);
    const name = padRight(s.name, PROBES_NAME_WIDTH);
    const latency = typeof s.latency === 'number' && s.latency >= 0 ? `${s.latency}ms` : '  --';
    const line = `${color}[${glyph}]${ANSI_RESET} ${name} ${padStart(latency, 8)}`;
    lines.push(line);
  }

  return '```ansi\n' + lines.join('\n') + '\n```';
}

function padStart(str, width) {
  if (str.length >= width) return str;
  return ' '.repeat(width - str.length) + str;
}

function buildServicesList(services) {
  return services.map((s) => {
    const glyph = statusGlyph(s.status);
    const label = `\`${statusLabelInline(s.status)}\``;
    const latency = typeof s.latency === 'number' && s.latency >= 0
      ? ` — \`${s.latency}ms\``
      : '';
    const detail = s.detail ? `\n> ${s.detail}` : '';
    return `**[${glyph}] ${s.name}** — ${label}${latency}${detail}`;
  }).join('\n');
}

/**
 * Build the reply payload (embed + components) for a given status result.
 * Layout mirrors the reference screenshot: bold "REAL STATUS" title, headline
 * banner, Product info section, Services section, and a monospace Probes
 * block with per-service latencies.
 */
function buildStatusPayload(result) {
  const { services, overall, checkedAt } = result;
  const checkedTs = Math.floor(checkedAt.getTime() / 1000);
  const bot = services.find(s => s.name === 'Discord Bot') ?? services[2];
  const uptimeMs = bot?.uptimeMs ?? 0;
  const wsPing = typeof bot?.latency === 'number' ? bot.latency : null;

  const productLines = [
    `• **Version:** \`${pkg.version}\``,
    wsPing != null ? `• **Gateway Ping:** \`${wsPing}ms\`` : `• **Gateway Ping:** \`Unknown\``,
    uptimeMs > 0 ? `• **Uptime:** \`${formatDuration(uptimeMs)}\`` : `• **Uptime:** \`Unknown\``,
    `• **Node:** \`${process.version}\``,
  ].join('\n');

  const description = [
    overallHeadline(overall),
    '',
    '**Product**',
    productLines,
    '',
    '**Services**',
    buildServicesList(services),
    '',
    '**Probes**',
    buildProbesBlock(services),
    '',
    `*Last checked <t:${checkedTs}:R> — use the button below to refresh*`,
  ].join('\n');

  // Create the base embed, then force the sidebar color to match overall status.
  const embed = createEmbed({
    title: 'REAL STATUS',
    description,
    color: 'dark',
    timestamp: false,
  });

  try {
    embed.setColor(overall.color);
  } catch {
    // ignore
  }

  return {
    embeds: [embed],
    components: [buildRefreshButton(false)],
  };
}

async function runStatusCheck(interaction) {
  try {
    const result = await checkAllServices(interaction.client);
    return buildStatusPayload(result);
  } catch (error) {
    logger.error('Status check failed with unexpected error:', error);
    // Fallback payload — never crash the interaction
    const embed = createEmbed({
      title: 'REAL STATUS',
      description: '**[!] Could not complete the status check.** Please try again in a moment.',
      color: 'warning',
    });
    return {
      embeds: [embed],
      components: [buildRefreshButton(false)],
    };
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('api')
    .setDescription('Check the status of the bot, GitHub, and Railway services'),

  async prefixExecute(interaction) {
    try {
      const thinkingMsg = await interaction.reply({ content: 'Checking service status…' });
      const payload = await runStatusCheck(interaction);
      await thinkingMsg.edit({ content: null, ...payload }).catch(() => {
        interaction.channel?.send(payload).catch(() => {});
      });
    } catch (error) {
      logger.error('API (prefix) command error:', error);
      interaction.channel?.send({
        embeds: [createEmbed({ title: 'REAL STATUS', description: 'Could not check service status.', color: 'error' })],
      }).catch(() => {});
    }
  },

  async execute(interaction) {
    const isButton = interaction.isButton?.() && interaction.customId === REFRESH_ID;

    if (isButton) {
      // Button press: defer an update, then re-check and rebuild
      try {
        await interaction.deferUpdate();
      } catch (deferError) {
        logger.warn('API status refresh: deferUpdate failed:', deferError?.message);
        return;
      }

      try {
        const payload = await runStatusCheck(interaction);
        await interaction.editReply(payload).catch(err => {
          logger.warn('API status refresh: editReply failed:', err?.message);
        });
      } catch (error) {
        logger.error('API status refresh error:', error);
        try {
          const embed = createEmbed({
            title: 'REAL STATUS',
            description: '**[X] Could not refresh status right now.** Try again shortly.',
            color: 'error',
          });
          await interaction.editReply({ embeds: [embed], components: [buildRefreshButton(false)] }).catch(() => {});
        } catch {
          // last-resort swallow
        }
      }
      return;
    }

    // Slash command — defer publicly so the status is visible to everyone
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {});
    if (!deferSuccess) {
      logger.warn(`API command: interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'api',
      });
      return;
    }

    try {
      const payload = await runStatusCheck(interaction);
      await InteractionHelper.safeEditReply(interaction, payload);
    } catch (error) {
      logger.error('API command error:', error);
      try {
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [createEmbed({ title: 'REAL STATUS', description: 'Could not check service status.', color: 'error' })],
          components: [],
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error('API command: failed to send error reply:', replyError);
      }
    }
  },
};

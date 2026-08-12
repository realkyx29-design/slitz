// ticketLogging.js

import { ChannelType } from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { logger } from '../logger.js';
import {
  buildStandardLogEmbed,
  formatRatingStars,
  resolveUserAuthor,
} from '../logging/logEmbeds.js';

export async function logTicketEvent({ client, guildId, event }) {
  try {
    if (!client || !guildId || !event?.type) {
      logger.warn('logTicketEvent called with an incomplete payload', {
        event: 'ticket.log.invalid',
        guildId: guildId || null,
        type: event?.type || null,
      });
      return false;
    }

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.warn('logTicketEvent invoked without a resolvable guild', {
        event: 'ticket.log.no_guild',
        guildId,
        type: event.type,
      });
      return false;
    }

    const config = await getGuildConfig(client, guildId);

    const logChannelId = getLogChannelForEventType(config, event.type);
    if (!logChannelId) {
      // Not configured (or an unrouted event type) — this is a normal no-op.
      logger.debug('Ticket event dropped: no destination configured', {
        event: 'ticket.log.unrouted',
        guildId,
        type: event.type,
        destination: getDestinationForEventType(event.type),
      });
      return false;
    }

    const channel = guild.channels.cache.get(logChannelId)
      || await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel) {
      logger.warn('Ticket log channel not found', {
        event: 'ticket.log.channel_missing',
        guildId,
        channelId: logChannelId,
        type: event.type,
      });
      return false;
    }

    if (!channel.isTextBased?.() || channel.type !== ChannelType.GuildText) {
      logger.warn('Ticket log channel is not a text channel', {
        event: 'ticket.log.channel_invalid',
        guildId,
        channelId: logChannelId,
        type: event.type,
      });
      return false;
    }

    // permissionsFor() returns null when the member is not cached/available —
    // calling .has() on that used to throw and swallow the whole log line.
    const botMember = guild.members.me
      || (client.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions || !permissions.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      logger.warn('Missing permissions in ticket log channel', {
        event: 'ticket.log.missing_permissions',
        guildId,
        channelId: logChannelId,
        type: event.type,
      });
      return false;
    }

    const embed = await createTicketLogEmbed(guild, event);

    const messageOptions = { embeds: [embed], allowedMentions: { parse: [] } };

    if (Array.isArray(event.attachments) && event.attachments.length > 0) {
      messageOptions.files = event.attachments;
    }

    await channel.send(messageOptions);
    logger.info('Ticket event logged', {
      event: 'ticket.log.sent',
      guildId,
      type: event.type,
      channelId: logChannelId,
      ticketId: event.ticketId || null,
    });
    return true;
  } catch (error) {
    logger.error('Error logging ticket event', {
      event: 'ticket.log.failed',
      guildId,
      type: event?.type || null,
      error: error.message,
    });
    return false;
  }
}

export async function logTicketFeedback({
  client,
  guildId,
  ticketNumber,
  ticketChannelId,
  userId,
  rating = null,
  comment = null,
}) {
  await logTicketEvent({
    client,
    guildId,
    event: {
      type: 'feedback',
      ticketId: ticketChannelId,
      ticketNumber,
      userId,
      metadata: {
        rating,
        comment,
      },
    },
  });
}

/**
 * Single source of truth for ticket log events: where each one is routed and
 * how it is rendered. Previously the routing switch and the style table were
 * maintained separately, so routed-but-unstyled events (pin/unpin) rendered as
 * a grey "Ticket Event".
 *
 * destination: 'lifecycle' | 'transcript' | 'ai'
 */
export const TICKET_EVENT_DEFINITIONS = {
  open: { destination: 'lifecycle', color: 0x5865F2, title: 'Ticket Created', emoji: '🎫' },
  close: { destination: 'lifecycle', color: 0xED4245, title: 'Ticket Closed', emoji: '🔒' },
  reopen: { destination: 'lifecycle', color: 0x57F287, title: 'Ticket Reopened', emoji: '🔓' },
  delete: { destination: 'lifecycle', color: 0x8b0000, title: 'Ticket Deleted', emoji: '🗑️' },
  claim: { destination: 'lifecycle', color: 0x5865F2, title: 'Ticket Claimed', emoji: '🙋' },
  unclaim: { destination: 'lifecycle', color: 0xFAA61A, title: 'Ticket Unclaimed', emoji: '↩️' },
  priority: { destination: 'lifecycle', color: 0x9b59b6, title: 'Priority Updated', emoji: '🎚️' },
  pin: { destination: 'lifecycle', color: 0x3498db, title: 'Ticket Pinned', emoji: '📌' },
  unpin: { destination: 'lifecycle', color: 0x95a5a6, title: 'Ticket Unpinned', emoji: '📍' },
  feedback: { destination: 'lifecycle', color: 0x57F287, title: 'Feedback Received', emoji: '⭐' },
  human_requested: { destination: 'lifecycle', color: 0x2ecc71, title: 'Human Support Requested', emoji: '🧑‍💼' },
  transcript: { destination: 'transcript', color: 0x57F287, title: 'Transcript Generated', emoji: '📄' },
  ai_player_report: { destination: 'ai', color: 0xE67E22, title: 'Player Report Detected', emoji: '🚨' },
  ai_player_report_update: { destination: 'ai', color: 0xF1C40F, title: 'Player Report Updated', emoji: '✏️' },
  ai_player_report_ready: { destination: 'ai', color: 0x57F287, title: 'Player Report Ready', emoji: '✅' },
  ai_close: { destination: 'ai', color: 0xED4245, title: 'Ticket Closed by AI', emoji: '🤖' },
  ai_warn: { destination: 'ai', color: 0xFAA61A, title: 'AI Warning Issued', emoji: '⚠️' },
  ai_kick: { destination: 'ai', color: 0x8b0000, title: 'User Kicked by AI', emoji: '🚫' },
  ai_error: { destination: 'ai', color: 0xED4245, title: 'AI Assistant Error', emoji: '💥' },
};

export const DESTINATION_CONFIG_KEYS = {
  lifecycle: 'ticketLogsChannelId',
  transcript: 'ticketTranscriptChannelId',
  ai: 'ticketAiLogsChannelId',
};

export function getDestinationForEventType(eventType) {
  return TICKET_EVENT_DEFINITIONS[eventType]?.destination || null;
}

export function getLogChannelForEventType(config, eventType) {
  const destination = getDestinationForEventType(eventType);
  if (!destination) {
    return null;
  }

  const primary = config?.[DESTINATION_CONFIG_KEYS[destination]];
  if (primary) {
    return primary;
  }

  // Graceful degradation: AI and transcript events still get logged when only
  // the main ticket log channel is configured, instead of vanishing silently.
  if (destination !== 'lifecycle') {
    return config?.ticketLogsChannelId || null;
  }

  return null;
}

const TICKET_EVENT_STYLES = TICKET_EVENT_DEFINITIONS;

async function createTicketLogEmbed(guild, event) {
  const style = TICKET_EVENT_STYLES[event.type] || { color: 0x95a5a6, title: 'Ticket Event', emoji: 'ℹ️' };
  const ticketNumber = event.ticketNumber || event.ticketId;
  const ticketRef = ticketNumber ? `#${ticketNumber}` : 'Unknown';
  const channelMention = event.ticketId ? `<#${event.ticketId}>` : null;
  const executorMention = event.executorId ? `<@${event.executorId}>` : null;
  const userMention = event.userId ? `<@${event.userId}>` : null;

  let inlineFields = [];
  let fields = [];
  let author = null;
  let footer = { text: 'TitanBot Ticketing' };

  switch (event.type) {
    case 'open':
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'close':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Closed by', value: executorMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'reopen':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Reopened by', value: executorMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      break;

    case 'delete':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Deleted by', value: executorMention || 'Unknown', inline: true },
      ];
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'pin':
    case 'unpin':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        {
          name: event.type === 'pin' ? 'Pinned by' : 'Unpinned by',
          value: executorMention || 'Unknown',
          inline: true,
        },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      break;

    case 'ai_close':
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      fields.push({
        name: 'Reason',
        value: String(event.reason || 'Issue resolved').slice(0, 1024),
        inline: false,
      });
      footer = { text: 'TitanBot Ticketing • autonomous AI action' };
      break;

    case 'ai_warn':
    case 'ai_kick': {
      const meta = event.metadata || {};
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'User', value: userMention || 'Unknown', inline: true },
      ];
      if (event.type === 'ai_warn') {
        inlineFields.push({
          name: 'Warning',
          value: `${meta.warningNumber ?? '?'} / ${meta.warningLimit ?? '?'}`,
          inline: true,
        });
      } else {
        inlineFields.push({
          name: 'Warnings given',
          value: String(meta.warningLimit ?? '?'),
          inline: true,
        });
      }
      if (channelMention) {
        fields.push({ name: 'Channel', value: channelMention, inline: false });
      }
      fields.push({
        name: 'Reason',
        value: String(event.reason || 'Trolling / misuse of the ticket').slice(0, 1024),
        inline: false,
      });
      footer = { text: 'TitanBot Ticketing • autonomous AI action' };
      break;
    }

    case 'ai_error':
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      fields.push({
        name: 'Error',
        value: String(event.reason || 'Unknown error').slice(0, 1024),
        inline: false,
      });
      break;

    case 'claim':
    case 'unclaim':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        {
          name: event.type === 'claim' ? 'Claimed by' : 'Unclaimed by',
          value: executorMention || 'Unknown',
          inline: true,
        },
      ];
      break;

    case 'ai_player_report':
    case 'ai_player_report_update':
    case 'ai_player_report_ready': {
      const meta = event.metadata || {};
      const username = meta.reportedUsername || 'Not provided yet';
      const videoStatus = meta.hasVideo
        ? `Provided${meta.videoUrls?.[0] ? `\n${String(meta.videoUrls[0]).slice(0, 200)}` : ''}`
        : 'Missing — still needed';
      const missing = Array.isArray(meta.missing) && meta.missing.length
        ? meta.missing.map((item) => `\`${item}\``).join(', ')
        : 'None';

      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Reporter', value: userMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      fields.push({ name: 'Reported player', value: String(username).slice(0, 1024), inline: true });
      fields.push({ name: 'Video evidence', value: videoStatus.slice(0, 1024), inline: true });
      fields.push({
        name: 'Screenshots',
        value: meta.hasImage ? 'Yes (video still preferred)' : 'None',
        inline: true,
      });
      fields.push({ name: 'Still missing', value: missing, inline: false });
      if (event.reason || meta.description) {
        fields.push({
          name: 'Details',
          value: String(event.reason || meta.description).slice(0, 1024),
          inline: false,
        });
      }
      break;
    }

    case 'human_requested':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Requested by', value: executorMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.metadata?.notifyUserId) {
        fields.push({
          name: 'Staff notified',
          value: `<@${event.metadata.notifyUserId}>`,
          inline: false,
        });
        fields.push({
          name: 'AI assistant',
          value: 'Stopped replying in this ticket.',
          inline: false,
        });
      }
      break;

    case 'priority': {
      const priorityEmojis = { none: '⚪', low: '🔵', medium: '🟢', high: '🟡', urgent: '🔴' };
      const priorityLabel = event.priority
        ? `${priorityEmojis[event.priority] || '⚪'} ${event.priority.charAt(0).toUpperCase()}${event.priority.slice(1)}`
        : 'Unknown';
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Priority', value: priorityLabel, inline: true },
        { name: 'Updated by', value: executorMention || 'Unknown', inline: true },
      ];
      break;
    }

    case 'transcript':
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (event.metadata?.messageCount) {
        inlineFields.push({ name: 'Messages', value: String(event.metadata.messageCount), inline: true });
      }
      if (event.metadata?.duration) {
        fields.push({ name: 'Duration', value: String(event.metadata.duration), inline: false });
      }
      if (event.metadata?.subject || event.reason) {
        fields.push({
          name: 'Subject',
          value: String(event.metadata?.subject || event.reason).slice(0, 1024),
          inline: false,
        });
      }
      break;

    case 'feedback': {
      const rating = event.metadata?.rating ?? event.rating;
      const comment = event.metadata?.comment;
      const ratingDisplay = formatRatingStars(rating) || 'No rating';

      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Rating', value: ratingDisplay, inline: true },
      ];

      if (comment) {
        fields.push({
          name: 'Comment',
          value: String(comment).slice(0, 1024),
          inline: false,
        });
      }
      break;
    }

    default:
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
      ];
      if (event.reason) {
        fields.push({ name: 'Details', value: String(event.reason).slice(0, 1024), inline: false });
      }
  }

  const titlePrefix = style.emoji ? `${style.emoji} ` : '';
  return buildStandardLogEmbed({
    color: style.color,
    title: `${titlePrefix}${style.title}`,
    inlineFields,
    fields,
    author,
    footer,
  });
}

export async function getTicketLoggingConfig(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  return {
    enabled: !!(config.ticketLogsChannelId || config.ticketTranscriptChannelId || config.ticketAiLogsChannelId),
    lifecycleChannelId: config.ticketLogsChannelId || null,
    transcriptChannelId: config.ticketTranscriptChannelId || null,
    aiLogsChannelId: config.ticketAiLogsChannelId || null,
  };
}

export function validateLogChannel(channel, botMember) {
  if (!channel || channel.type !== ChannelType.GuildText) {
    return {
      valid: false,
      error: 'Channel must be a text channel.',
    };
  }

  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = ['SendMessages', 'EmbedLinks'];

  const missing = requiredPermissions.filter((perm) => !permissions.has(perm));

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing permissions: ${missing.join(', ')}`,
    };
  }

  return { valid: true };
}


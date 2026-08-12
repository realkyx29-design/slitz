import { PermissionsBitField, ChannelType } from 'discord.js';
import { setLogChannel } from '../../../services/loggingService.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
const TICKET_DESTINATIONS = new Set(['ticket-events', 'ticket-transcripts', 'ticket-ai']);

const DESTINATION_LABELS = {
  audit: 'Audit Log',
  applications: 'Applications',
  reports: 'Reports',
  'ticket-events': 'Ticket Events',
  'ticket-transcripts': 'Ticket Transcripts',
  'ticket-ai': 'Ticket AI Actions',
};

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    try {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Server** permissions to configure logging channels.' });
      }

      await InteractionHelper.safeDefer(interaction, { ephemeral: true });

      const destination = interaction.options.getString('destination');
      const channel = interaction.options.getChannel('channel');
      const disable = interaction.options.getBoolean('disable') ?? false;

      const label = DESTINATION_LABELS[destination] || destination;

      if (disable) {
        const cleared = await setLogChannel(client, interaction.guildId, destination, null);
        if (!cleared) {
          return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Failed to clear the **${label}** channel. Please try again.` });
        }
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed(
            'Channel Cleared',
            `The **${label}** channel has been removed.`,
          )],
        });
      }

      if (!channel || channel.type !== ChannelType.GuildText) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please provide a valid text channel.' });
      }

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `I need **View Channel**, **Send Messages**, and **Embed Links** in ${channel}.` });
      }

      const saved = await setLogChannel(client, interaction.guildId, destination, channel.id);
      if (!saved) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Failed to save the **${label}** channel. Please try again.` });
      }

      // Category toggles only apply to audit events, so don't point ticket
      // destinations at a dashboard that cannot configure them.
      const hint = TICKET_DESTINATIONS.has(destination)
        ? 'Use `/ticket dashboard` for the rest of the ticket settings.'
        : 'Use `/logging dashboard` to toggle event categories.';

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          'Channel Updated',
          `**${label}** logs will be sent to ${channel}.\n${hint}`,
        )],
      });
    } catch (error) {
      logger.error('logging_channel error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to update the log channel.' });
    }
  },
};

import apiCommand from '../../commands/Core/api.js';

/**
 * Refresh button for the /api status embed.
 * Delegates to the command's execute() which detects button presses via
 * interaction.customId starting with 'api:' and re-runs the checks, editing
 * the original reply in place.
 */
export default {
  name: 'api',
  async execute(interaction, client) {
    try {
      await apiCommand.execute(interaction);
    } catch (error) {
      // Safety net — the command already handles its own errors, but catch
      // anything unexpected so the interaction never crashes the event loop.
      try {
        const { createEmbed } = await import('../../utils/embeds.js');
        const { InteractionHelper } = await import('../../utils/interactionHelper.js');
        const embed = createEmbed({
          title: 'System Error',
          description: 'Could not refresh service status. Please try again later.',
          color: 'error',
        });
        if (interaction.deferred || interaction.replied) {
          await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [] });
        } else {
          await InteractionHelper.safeReply(interaction, { embeds: [embed], ephemeral: true });
        }
      } catch {
        // last-resort swallow
      }
    }
  },
};

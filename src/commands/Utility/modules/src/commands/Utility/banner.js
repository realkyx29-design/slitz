import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    category: 'Utility',
    data: new SlashCommandBuilder()
        .setName('banner')
        .setDescription("Display a user's profile banner")
        .addUserOption((option) =>
            option
                .setName('user')
                .setDescription('The user whose banner you want to see (defaults to you)'),
        ),

    async execute(interaction) {
        const target = interaction.options.getUser('user') || interaction.user;

        // Banner data is only available on a fully fetched user.
        let user = target;
        try {
            user = await interaction.client.users.fetch(target.id, { force: true });
        } catch (error) {
            logger.warn(`Banner user fetch failed for ${target.id}: ${error?.message || error}`);
        }

        const bannerUrl = user.bannerURL({ size: 2048, dynamic: true });

        if (!bannerUrl) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [successEmbed('No Banner', `**${user.username}** doesn't have a profile banner set.`)],
            });
            logger.info('Banner command executed (no banner)', {
                userId: interaction.user.id,
                targetUserId: user.id,
                guildId: interaction.guildId,
            });
            return;
        }

        const embed = createEmbed({
            title: `${user.username}'s Banner`,
            description: `[Download Link](${bannerUrl})`,
            color: 'info',
            image: bannerUrl,
            footer: `Requested by ${interaction.user.username}`,
        });

        await InteractionHelper.safeReply(interaction, { embeds: [embed] });
        logger.info('Banner command executed', {
            userId: interaction.user.id,
            targetUserId: user.id,
            guildId: interaction.guildId,
        });
    },
};

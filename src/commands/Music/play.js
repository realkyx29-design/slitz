import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { playQuery, replyMusicSuccess } from '../../services/music/musicActions.js';
import { SEARCH_SOURCE_CHOICES } from '../../services/music/sources.js';

export default {
    slashOnly: true,
    category: 'Music',
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song, search, or paste a link (YouTube, Spotify, etc.)')
        .addStringOption((opt) =>
            opt
                .setName('query')
                .setDescription('Song name, search query, or URL (YouTube, Spotify, SoundCloud...)')
                .setRequired(true),
        )
        .addStringOption((opt) =>
            opt
                .setName('source')
                .setDescription('Where to search (ignored when the query is a URL)')
                .setRequired(false)
                .addChoices(
                    { name: 'Auto (default)', value: 'auto' },
                    ...SEARCH_SOURCE_CHOICES,
                ),
        ),

    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('query');
        const source = interaction.options.getString('source') || 'auto';
        const result = await playQuery(client, interaction, query, source);
        await replyMusicSuccess(interaction, result.embed);
    },
};

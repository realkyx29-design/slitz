import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import {
    DEFAULT_HONEYPOT_CONFIG,
    getHoneypotConfig,
    deployHoneypot,
    refreshHoneypotEmbed,
    removeHoneypot,
    normalizeHoneypotConfig,
} from '../../services/honeypotService.js';
import { updateGuildConfig } from '../../services/config/guildConfig.js';

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];

const TEXT_OPTIONS = {
    heading_line1: 'First heading line',
    heading_line2: 'Second heading line',
    heading_line3: 'Third heading line',
    description: 'Small description text below the heading',
    counter: 'Counter label shown at the bottom (e.g. "Kicks")',
    icon: 'Emoji shown at the top, or an image URL for a logo',
    color: 'Embed color as a hex code (e.g. #2F3136)',
};

function resolveTargetChannel(interaction) {
    const selected = interaction.options.getChannel('channel');
    if (selected) {
        return selected;
    }

    if (!interaction.channel || !TEXT_CHANNEL_TYPES.includes(interaction.channel.type)) {
        return null;
    }

    return interaction.channel;
}

function buildStatusEmbed({ honeypot, guild }) {
    const hp = normalizeHoneypotConfig(honeypot);
    const isActive = hp.enabled && hp.channelId;

    const embed = new EmbedBuilder();
    embed.setColor(hp.color || '#2F3136');
    embed.data.author = {
        name: 'Honeypot',
        icon_url: guild?.members?.me?.displayAvatarURL({ size: 128 }),
    };
    embed.data.title = 'Honeypot Status';
    embed.data.description = [
        isActive ? `**Status:** Active in ${guild?.channels?.cache?.get(hp.channelId) || `<#${hp.channelId}>`}` : '**Status:** Disabled',
        `**Kicks:** ${Number(hp.kicks) || 0}`,
        `**Icon:** ${hp.icon || '⚠️'}`,
        `**Counter label:** ${hp.counterLabel || 'Kicks'}`,
        `**Color:** ${hp.color || '#2F3136'}`,
        '',
        '**Heading**',
        '```',
        (Array.isArray(hp.heading) ? hp.heading : []).join('\n') || DEFAULT_HONEYPOT_CONFIG.heading.join('\n'),
        '```',
        '**Description**',
        hp.description || DEFAULT_HONEYPOT_CONFIG.description,
        '',
        isActive
            ? 'Run `/honeypot setup` to move it, `/honeypot text` to change the wording, or `/honeypot remove` to delete it.'
            : 'Run `/honeypot setup` to post the embed in a channel.',
    ].join('\n');

    return embed;
}

export default {
    data: new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription('Set up a honeypot channel that catches and softbans spam bots.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('setup')
                .setDescription('Post the honeypot embed to a channel (defaults to this channel).')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('Channel to post the honeypot embed in.')
                        .addChannelTypes(...TEXT_CHANNEL_TYPES)
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('text')
                .setDescription('Customize the honeypot embed text and re-render it in place.')
                .addStringOption((option) =>
                    option
                        .setName('heading_line1')
                        .setDescription(TEXT_OPTIONS.heading_line1)
                        .setMaxLength(64)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('heading_line2')
                        .setDescription(TEXT_OPTIONS.heading_line2)
                        .setMaxLength(64)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('heading_line3')
                        .setDescription(TEXT_OPTIONS.heading_line3)
                        .setMaxLength(64)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('description')
                        .setDescription(TEXT_OPTIONS.description)
                        .setMaxLength(1024)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('counter')
                        .setDescription(TEXT_OPTIONS.counter)
                        .setMaxLength(32)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('icon')
                        .setDescription(TEXT_OPTIONS.icon)
                        .setMaxLength(256)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('color')
                        .setDescription(TEXT_OPTIONS.color)
                        .setMaxLength(16)
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('remove')
                .setDescription('Delete the honeypot embed and disable the honeypot.'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('status')
                .setDescription('Show the current honeypot configuration.'),
        ),
    category: 'moderation',
    slashOnly: true,

    async execute(interaction, config, client) {
        try {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'setup') {
                return await handleSetup(interaction, config, client);
            }
            if (subcommand === 'text') {
                return await handleText(interaction, config, client);
            }
            if (subcommand === 'remove') {
                return await handleRemove(interaction, config, client);
            }
            if (subcommand === 'status') {
                return await handleStatus(interaction, config, client);
            }

            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'This subcommand is not recognised.',
            });
        } catch (error) {
            logger.error('honeypot command error:', error);
            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'An unexpected error occurred while running `/honeypot`.',
            }).catch(() => {});
        }
    },
};

async function handleSetup(interaction, _config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;

    const channel = resolveTargetChannel(interaction);
    if (!channel) {
        return replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Choose a text channel or run this command in one.',
        });
    }

    const botPermissions = channel.permissionsFor(interaction.guild.members.me);
    if (
        !botPermissions?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
        ])
    ) {
        return replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: `I need **View Channel**, **Send Messages**, and **Embed Links** in ${channel} to post the honeypot.`,
        });
    }

    try {
        const { message, config } = await deployHoneypot({
            client,
            guild: interaction.guild,
            channel,
        });

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setDescription(
                [
                    `✅ Honeypot posted in ${channel}.`,
                    '',
                    'Anyone who sends a message here will be **kicked** and counted in the embed footer.',
                    '',
                    `Use \`/honeypot text\` to change the wording, or [jump to the embed](${message.url}).`,
                ].join('\n'),
            );

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        logger.info(`Honeypot setup by ${interaction.user.tag} in guild ${interaction.guild.id}`, {
            channelId: config.channelId,
        });
    } catch (error) {
        logger.error('honeypot setup error:', error);
        await replyUserError(interaction, {
            type: ErrorTypes.UNKNOWN,
            message: 'Failed to post the honeypot embed. Check my permissions and try again.',
        });
    }
}

async function handleText(interaction, _config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;

    const provided = {
        heading_line1: interaction.options.getString('heading_line1'),
        heading_line2: interaction.options.getString('heading_line2'),
        heading_line3: interaction.options.getString('heading_line3'),
        description: interaction.options.getString('description'),
        counter: interaction.options.getString('counter'),
        icon: interaction.options.getString('icon'),
        color: interaction.options.getString('color'),
    };

    const hasAnyChange = Object.values(provided).some((value) => value !== null);
    if (!hasAnyChange) {
        return replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Provide at least one value to change (heading lines, description, counter, icon, or color).',
        });
    }

    const current = await getHoneypotConfig(client, interaction.guild.id);

    let heading = current.heading;
    const headingLines = [provided.heading_line1, provided.heading_line2, provided.heading_line3]
        .map((line) => (line === null ? null : line.trim()))
        .filter((line) => line !== null);
    if (headingLines.length > 0) {
        heading = heading.map((line, index) =>
            headingLines[index] !== undefined ? headingLines[index] : line,
        );
        // If the stored heading had fewer lines than provided, extend it.
        while (heading.length < headingLines.length) {
            heading.push(headingLines[heading.length]);
        }
        // Title limit is 256 chars — keep at most 3 lines.
        heading = heading.slice(0, 3);
    }

    let color = provided.color;
    if (color !== null) {
        color = color.trim().startsWith('#') ? color.trim() : `#${color.trim()}`;
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Color must be a 6-digit hex code, e.g. `#2F3136`.',
            });
        }
    }

    const updated = normalizeHoneypotConfig({
        ...current,
        heading,
        ...(provided.description !== null ? { description: provided.description.trim() } : {}),
        ...(provided.counter !== null ? { counterLabel: provided.counter.trim() } : {}),
        ...(provided.icon !== null ? { icon: provided.icon.trim() } : {}),
        ...(color !== null ? { color } : {}),
    });

    await updateGuildConfig(client, interaction.guild.id, { honeypot: updated });

    let refreshed = false;
    if (updated.enabled && updated.channelId && updated.messageId) {
        refreshed = await refreshHoneypotEmbed(client, interaction.guild.id, updated);
    }

    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setDescription(
            [
                `✅ Honeypot text updated.`,
                refreshed
                    ? 'The embed has been **re-rendered in place**.'
                    : 'Post the embed with `/honeypot setup` to apply the new text.',
                '',
                `Use \`/honeypot status\` to review the current configuration.`,
            ].join('\n'),
        );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleRemove(interaction, _config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;

    const current = await getHoneypotConfig(client, interaction.guild.id);
    if (!current.enabled && !current.channelId) {
        return replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'There is no honeypot to remove.',
        });
    }

    await removeHoneypot(client, interaction.guild.id);

    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setDescription('✅ Honeypot removed. The embed has been deleted and the channel is no longer monitored.');

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleStatus(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;

    const honeypot = await getHoneypotConfig(client, interaction.guild.id);
    const embed = buildStatusEmbed({ honeypot, guild: interaction.guild });
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

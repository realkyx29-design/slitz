import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];
const IMAGE_FILE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i;

export function isImageAttachment(attachment) {
    if (!attachment) return false;

    if (typeof attachment.contentType === 'string') {
        return attachment.contentType.toLowerCase().startsWith('image/');
    }

    // Discord normally supplies contentType. Keep uploads from older clients usable
    // when their filename clearly identifies a supported image format.
    return IMAGE_FILE_EXTENSION.test(attachment.name || '');
}

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

export default {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Send a message or image as the bot')
        .addStringOption((option) =>
            option
                .setName('message')
                .setDescription('The optional message the bot should send')
                .setRequired(false)
                .setMaxLength(2000),
        )
        .addAttachmentOption((option) =>
            option
                .setName('image')
                .setDescription('An optional image to send')
                .setRequired(false),
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('Channel to send in (defaults to the current channel)')
                .addChannelTypes(...TEXT_CHANNEL_TYPES)
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setDMPermission(false),
    category: 'moderation',
    abuseProtection: { maxAttempts: 8, windowMs: 60_000 },

    async execute(interaction, _config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferSuccess) {
            logger.warn('Say interaction defer failed', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'say',
            });
            return;
        }

        const rawMessage = interaction.options.getString('message');
        const message = sanitizeInput(rawMessage, 2000);
        const image = interaction.options.getAttachment('image');

        if (!message && !image) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Add a message, an image, or both.',
            });
        }

        if (image && !isImageAttachment(image)) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'The uploaded attachment must be an image.',
            });
        }

        const channel = resolveTargetChannel(interaction);
        if (!channel) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Choose a text channel or run this command in one.',
            });
        }

        const memberPermissions = channel.permissionsFor(interaction.member);
        const botPermissions = channel.permissionsFor(interaction.guild.members.me);

        if (!memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `You do not have permission to send messages in ${channel}.`,
            });
        }

        if (image && !memberPermissions.has(PermissionFlagsBits.AttachFiles)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `You do not have permission to attach files in ${channel}.`,
            });
        }

        if (!botPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `I do not have permission to send messages in ${channel}.`,
            });
        }

        if (image && !botPermissions.has(PermissionFlagsBits.AttachFiles)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `I need permission to attach files in ${channel}.`,
            });
        }

        const sendPayload = {};
        if (message) sendPayload.content = message;
        if (image) {
            sendPayload.files = [{
                attachment: image.url,
                name: image.name,
                description: image.description || undefined,
            }];
        }

        const sentMessage = await channel.send(sendPayload);

        await logEvent({
            client,
            guild: interaction.guild,
            event: {
                action: 'Bot Message Sent',
                target: `${channel} (${channel.id})`,
                executor: `${interaction.user.tag} (${interaction.user.id})`,
                reason: message
                    ? (message.length > 200 ? `${message.slice(0, 197)}...` : message)
                    : `Image: ${image.name}`,
                metadata: {
                    channelId: channel.id,
                    messageId: sentMessage.id,
                    moderatorId: interaction.user.id,
                    messageLength: message.length,
                    imageName: image?.name || null,
                    imageSize: image?.size || null,
                },
            },
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    'Message Sent',
                    `Posted in ${channel}. [Jump to message](${sentMessage.url})`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};

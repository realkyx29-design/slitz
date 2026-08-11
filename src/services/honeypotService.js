// honeypotService.js — Honeypot bait channel.
//
// A honeypot is a channel whose only purpose is to catch spam bots: the bot
// posts a warning embed, and anyone who sends a message in the channel is
// deleted + softbanned (kicked). Every kick increments the counter shown in
// the embed footer, so moderators can see how many bots were caught.

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { ModerationService } from './moderation/moderationService.js';

export const DEFAULT_HONEYPOT_CONFIG = {
    enabled: false,
    channelId: null,
    messageId: null,
    kicks: 0,
    // Icon shown at the top of the embed (an emoji, or an image URL for a logo).
    icon: '⚠️',
    // Big bold heading — each entry is one line of the embed title.
    heading: ['DO NOT SEND', 'MESSAGES IN THIS', 'CHANNEL'],
    description:
        'This channel is used to catch spam bots. Any messages sent here will result in a **softban.**',
    // Footer counter label, e.g. "Kicks".
    counterLabel: 'Kicks',
    // Dark embed color (Discord dark theme sidebar).
    color: '#2F3136',
};

const IMAGE_URL_REGEX = /^https?:\/\//i;

export function normalizeHoneypotConfig(honeypot) {
    return {
        ...DEFAULT_HONEYPOT_CONFIG,
        ...(honeypot && typeof honeypot === 'object' ? honeypot : {}),
    };
}

export async function getHoneypotConfig(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    return normalizeHoneypotConfig(config?.honeypot);
}

/**
 * Build the honeypot embed.
 *
 * NOTE: the embed is assembled through `embed.data` on purpose. The global
 * embed helpers in utils/embeds.js sanitize titles/descriptions/authors by
 * stripping emojis and silently drop "unimportant" footers — both of which
 * would break the honeypot design (emoji icon + "Kicks: 0" footer).
 */
export function buildHoneypotEmbed({ honeypot, guild, client }) {
    const hp = normalizeHoneypotConfig(honeypot);

    const heading =
        Array.isArray(hp.heading) && hp.heading.length > 0
            ? hp.heading.slice(0, 3).map((line) => String(line).trim()).filter(Boolean)
            : DEFAULT_HONEYPOT_CONFIG.heading;

    const icon = String(hp.icon || '').trim();
    const isImageIcon = IMAGE_URL_REGEX.test(icon);

    const author = {
        name: isImageIcon ? 'Honeypot' : icon || '⚠️',
    };

    // snake_case on purpose — this is how discord.js stores/emits author icons.
    if (isImageIcon) {
        author.icon_url = icon;
    } else {
        const avatar =
            guild?.members?.me?.displayAvatarURL({ size: 128 }) ||
            client?.user?.displayAvatarURL({ size: 128 });
        if (avatar) {
            author.icon_url = avatar;
        }
    }

    const embed = new EmbedBuilder();
    embed.setColor(hp.color || DEFAULT_HONEYPOT_CONFIG.color);
    embed.data.title = heading.join('\n');
    embed.data.description =
        typeof hp.description === 'string' && hp.description.trim()
            ? hp.description.trim()
            : DEFAULT_HONEYPOT_CONFIG.description;
    embed.data.author = author;
    embed.data.footer = {
        text: `${hp.counterLabel || 'Kicks'}: ${Number(hp.kicks) || 0}`,
    };

    return embed;
}

/**
 * Post the honeypot embed to a channel and save the configuration.
 * If an embed already exists (in this or another channel) it is deleted first.
 */
export async function deployHoneypot({ client, guild, channel }) {
    const config = await getGuildConfig(client, guild.id);
    const honeypot = normalizeHoneypotConfig(config.honeypot);

    if (honeypot.enabled && honeypot.channelId && honeypot.messageId) {
        const oldChannel =
            guild.channels.cache.get(honeypot.channelId) ||
            (await guild.channels.fetch(honeypot.channelId).catch(() => null));
        if (oldChannel) {
            await oldChannel.messages
                .fetch(honeypot.messageId)
                .then((message) => message.delete().catch(() => {}))
                .catch(() => {});
        }
    }

    const embed = buildHoneypotEmbed({ honeypot, guild, client });
    const message = await channel.send({ embeds: [embed] });

    const updated = {
        ...honeypot,
        enabled: true,
        channelId: channel.id,
        messageId: message.id,
    };

    await updateGuildConfig(client, guild.id, { honeypot: updated });
    logger.info(`Honeypot deployed in channel ${channel.id} (guild ${guild.id})`);

    return { message, config: updated };
}

/**
 * Re-render the existing honeypot embed in place (used after config changes).
 * Returns false when there is nothing to refresh or the message is gone.
 */
export async function refreshHoneypotEmbed(client, guildId, honeypot) {
    const hp = normalizeHoneypotConfig(honeypot);
    if (!hp.enabled || !hp.channelId || !hp.messageId) {
        return false;
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;

    const channel =
        guild.channels.cache.get(hp.channelId) ||
        (await guild.channels.fetch(hp.channelId).catch(() => null));
    if (!channel) return false;

    const message = await channel.messages.fetch(hp.messageId).catch(() => null);
    if (!message) return false;

    const embed = buildHoneypotEmbed({ honeypot: hp, guild, client });
    await message.edit({ embeds: [embed] });
    return true;
}

/**
 * Delete the honeypot embed and disable the honeypot. Text configuration is
 * kept so a later /honeypot setup reuses the same style.
 */
export async function removeHoneypot(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    const honeypot = normalizeHoneypotConfig(config.honeypot);

    if (honeypot.enabled && honeypot.channelId && honeypot.messageId) {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        const channel = guild
            ? guild.channels.cache.get(honeypot.channelId) ||
              (await guild.channels.fetch(honeypot.channelId).catch(() => null))
            : null;
        if (channel) {
            await channel.messages
                .fetch(honeypot.messageId)
                .then((message) => message.delete().catch(() => {}))
                .catch(() => {});
        }
    }

    const updated = {
        ...honeypot,
        enabled: false,
        channelId: null,
        messageId: null,
    };

    await updateGuildConfig(client, guildId, { honeypot: updated });
    logger.info(`Honeypot removed (guild ${guildId})`);
    return updated;
}

/**
 * Increment the kicks counter and refresh the embed footer.
 */
export async function recordHoneypotKick(client, guildId, currentHoneypot) {
    const config = await getGuildConfig(client, guildId);
    const honeypot = normalizeHoneypotConfig(config.honeypot || currentHoneypot);

    const updated = {
        ...honeypot,
        kicks: (Number(honeypot.kicks) || 0) + 1,
    };

    await updateGuildConfig(client, guildId, { honeypot: updated });
    await refreshHoneypotEmbed(client, guildId, updated).catch((error) => {
        logger.warn('Failed to refresh honeypot embed after kick', {
            guildId,
            error,
        });
    });

    return updated;
}

/**
 * Message hook: when a message is sent in the honeypot channel, delete it and
 * softban (kick) the author, unless it is the bot's own honeypot embed.
 * Returns true when the message was handled by the honeypot.
 */
export async function handleHoneypotMessage(message, client) {
    try {
        if (!message.guild) return false;

        const honeypot = await getHoneypotConfig(client, message.guild.id);
        if (!honeypot.enabled || !honeypot.channelId) return false;
        if (message.channel.id !== honeypot.channelId) return false;

        // Never treat the bot's own embed as bait.
        if (message.author.id === client.user.id) return false;

        await message.delete().catch(() => {});

        const botMember =
            message.guild.members.me ||
            (await message.guild.members.fetch(client.user.id).catch(() => null));

        let member = message.guild.members.cache.get(message.author.id);
        if (!member) {
            member = await message.guild.members
                .fetch(message.author.id)
                .catch(() => null);
        }

        // Safety: never kick the guild owner or server admins/managers.
        const isProtected =
            !member ||
            member.id === message.guild.ownerId ||
            member.permissions.has(PermissionFlagsBits.Administrator) ||
            member.permissions.has(PermissionFlagsBits.ManageGuild);

        if (!isProtected && botMember) {
            try {
                await ModerationService.kickUser({
                    guild: message.guild,
                    member,
                    moderator: botMember,
                    reason: `Sent a message in the honeypot channel #${message.channel.name} — suspected spam bot.`,
                });
                await recordHoneypotKick(client, message.guild.id, honeypot);
            } catch (error) {
                logger.warn('Honeypot kick failed', {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    error: error?.message || error,
                });
            }
        }

        return true;
    } catch (error) {
        logger.error('Error handling honeypot message:', error);
        return false;
    }
}

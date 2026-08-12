import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getGuildConfig, setGuildConfig } from '../../../services/config/guildConfig.js';
import { getGuildTicketStats } from '../../../utils/database/tickets.js';
import {
    getTicketPanelStatus,
    messageHasButtonCustomId,
    formatPanelStatusField,
} from '../../../utils/panelStatus.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';

// ---------------------------------------------------------------------------
// Panel / embed builders
// ---------------------------------------------------------------------------

function buildButtonRow(guildConfig, guildId, disabled = false, panelStatus = null) {
    const dmEnabled = guildConfig.dmOnClose !== false;
    const showRepost = panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';

    const buttons = [];
    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`ticket_cfg_repost_${guildId}`)
                .setLabel('Repost Panel')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📌')
                .setDisabled(disabled),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_dm_toggle_${guildId}`)
            .setLabel('DM on Close')
            .setStyle(dmEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
            .setEmoji(dmEnabled ? '📬' : '📭')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_staff_role_btn_${guildId}`)
            .setLabel('Staff Role')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛡️')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_delete_${guildId}`)
            .setLabel('Delete System')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
            .setDisabled(disabled),
    );

    return new ActionRowBuilder().addComponents(buttons);
}

async function persistPanelMessageId(client, guildId, guildConfig, messageId) {
    if (!messageId || guildConfig.ticketPanelMessageId === messageId) return;
    guildConfig.ticketPanelMessageId = messageId;
    if (client.db) await setGuildConfig(client, guildId, guildConfig);
}

const buildPanelEmbed = (config) =>
    new EmbedBuilder()
        .setTitle('Support Tickets')
        .setDescription(config.ticketPanelMessage || 'Click the button below to create a support ticket.')
        .setColor(getColor('info'));

const buildPanelButtonRow = (config) =>
    new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel(config.ticketButtonLabel || 'Create Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📩'),
    );

async function repostTicketPanel(client, guild, guildConfig, guildId) {
    const channel = await guild.channels.fetch(guildConfig.ticketPanelChannelId).catch(() => null);
    if (!channel) {
        throw new TitanBotError(
            'Panel channel missing',
            ErrorTypes.CONFIGURATION,
            'The configured ticket panel channel no longer exists. Set a new panel channel from the dashboard.',
        );
    }

    const sentPanel = await channel.send({
        embeds: [buildPanelEmbed(guildConfig)],
        components: [buildPanelButtonRow(guildConfig)],
    });

    await persistPanelMessageId(client, guildId, guildConfig, sentPanel.id);
    return sentPanel;
}

const formatCloseDuration = (ms) => {
    if (ms == null) return '`N/A`';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

function buildDashboardEmbed(config, guild, panelStatus = null, ticketStats = null) {
    const mention = (id, prefix = '#') => (id ? `<${prefix}${id}>` : '`Not set`');
    const category = (id) => {
        const channel = id ? guild.channels.cache.get(id) : null;
        return channel ? channel.toString() : '`Not set`';
    };

    const rawMsg = config.ticketPanelMessage || 'Click the button below to create a support ticket.';
    const panelMsg = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;

    const openTickets = ticketStats ? String(ticketStats.openCount) : '`—`';
    const avgCloseTime = ticketStats ? formatCloseDuration(ticketStats.avgCloseTimeMs) : '`—`';
    const feedbackSummary = ticketStats?.feedbackCount
        ? `${ticketStats.avgRating}/5 (${ticketStats.feedbackCount} rating${ticketStats.feedbackCount !== 1 ? 's' : ''})`
        : '`No ratings yet`';

    return new EmbedBuilder()
        .setTitle('🎫 Ticket System Dashboard')
        .setDescription(`Manage ticket system settings for **${guild.name}**.\nSelect an option below to modify a setting.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Panel Status', value: formatPanelStatusField(panelStatus), inline: false },
            { name: 'Panel Channel', value: mention(config.ticketPanelChannelId), inline: true },
            { name: 'Staff Role', value: mention(config.ticketStaffRoleId, '@&'), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Open Tickets Category', value: category(config.ticketCategoryId), inline: true },
            { name: 'Closed Tickets Category', value: category(config.ticketClosedCategoryId), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Panel Message', value: panelMsg, inline: false },
            { name: 'Button Label', value: `\`${config.ticketButtonLabel || 'Create Ticket'}\``, inline: true },
            { name: 'Max Tickets/User', value: String(config.maxTicketsPerUser || 3), inline: true },
            { name: 'DM on Close', value: config.dmOnClose !== false ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Ticket Logs Channel', value: mention(config.ticketLogsChannelId), inline: true },
            { name: 'Transcript Channel', value: mention(config.ticketTranscriptChannelId), inline: true },
            { name: 'AI Logs Channel', value: mention(config.ticketAiLogsChannelId), inline: true },
            { name: 'Open Tickets', value: openTickets, inline: true },
            { name: 'Avg Close Time', value: avgCloseTime, inline: true },
            { name: 'Feedback Rating', value: feedbackSummary, inline: true },
        )
        .setFooter({ text: 'Select an option below • Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

const SETTING_OPTIONS = [
    { label: 'Edit Panel Message', description: 'Change the message displayed on the ticket creation panel', value: 'panel_message', emoji: '📝' },
    { label: 'Edit Button Label', description: 'Change the label on the Create Ticket button', value: 'button_label', emoji: '🏷️' },
    { label: 'Change Open Tickets Category', description: 'Category where new tickets are created', value: 'open_category', emoji: '📁' },
    { label: 'Change Closed Tickets Category', description: 'Category where closed tickets are moved', value: 'closed_category', emoji: '📂' },
    { label: 'Set Max Tickets per User', description: 'Limit how many open tickets one user can have at once', value: 'max_tickets', emoji: '🔢' },
    { label: 'Set Ticket Logs Channel', description: 'Channel to receive ticket feedback, lifecycle events, and logs', value: 'logs_channel', emoji: '🎫' },
    { label: 'Set Transcript Channel', description: 'Channel to receive auto-generated transcripts on deletion', value: 'transcript_channel', emoji: '📜' },
    { label: 'Set AI Logs Channel', description: 'Channel for player-report and ticket AI intake logs', value: 'ai_logs_channel', emoji: '🤖' },
];

const buildSelectMenu = (guildId) =>
    new StringSelectMenuBuilder()
        .setCustomId(`ticket_config_${guildId}`)
        .setPlaceholder('Select a setting to configure...')
        .addOptions(SETTING_OPTIONS.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.label).setDescription(o.description).setValue(o.value).setEmoji(o.emoji)));

async function refreshDashboard(rootInteraction, guildConfig, guildId, client) {
    const panelStatus = client ? await getTicketPanelStatus(client, rootInteraction.guild, guildConfig) : null;
    const ticketStats = client ? await getGuildTicketStats(guildId) : null;

    if (panelStatus?.recoveredId) {
        await persistPanelMessageId(client, guildId, guildConfig, panelStatus.recoveredId);
    }

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(guildConfig, rootInteraction.guild, panelStatus, ticketStats)],
        components: [buildButtonRow(guildConfig, guildId, false, panelStatus), new ActionRowBuilder().addComponents(buildSelectMenu(guildId))],
    }).catch(() => {});
}

async function updateLivePanel(client, guild, config, guildId) {
    if (!config.ticketPanelChannelId) return false;
    try {
        const panelStatus = await getTicketPanelStatus(client, guild, config);
        if (panelStatus.recoveredId) {
            await persistPanelMessageId(client, guildId, config, panelStatus.recoveredId);
        }
        if (!panelStatus.exists || !panelStatus.message) return false;

        await panelStatus.message.edit({ embeds: [buildPanelEmbed(config)], components: [buildPanelButtonRow(config)] });
        return true;
    } catch (error) {
        logger.warn('Failed to update live ticket panel:', error.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Generic flows — every "pick a role/channel" and "type text in a modal"
// handler below is built from these two helpers instead of being hand-rolled.
// ---------------------------------------------------------------------------

/**
 * Shows a followUp with a select menu, waits for a pick, saves it, and
 * refreshes the dashboard. Powers the staff-role / category / channel pickers.
 */
async function runSelectFlow({
    selectInteraction, rootInteraction, guildConfig, guildId, client,
    customId, componentType, menu, embedTitle, embedDescription,
    getSelected, onSave, timeoutMessage,
}) {
    await selectInteraction.deferUpdate();

    await selectInteraction.followUp({
        embeds: [new EmbedBuilder().setTitle(embedTitle).setDescription(embedDescription).setColor(getColor('info'))],
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType,
        filter: (i) => i.user.id === selectInteraction.user.id && i.customId === customId,
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async (picked) => {
        await picked.deferUpdate();
        const resultEmbed = await onSave(getSelected(picked));
        await picked.followUp({ embeds: [resultEmbed], flags: MessageFlags.Ephemeral });
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, { type: ErrorTypes.RATE_LIMIT, message: timeoutMessage }).catch(() => {});
        }
    });
}

/**
 * Shows a single-field modal, waits for submission, validates + saves the
 * value, and refreshes the dashboard. Powers panel message / button label / max tickets.
 */
async function runModalFlow({
    selectInteraction, rootInteraction, guildConfig, guildId, client,
    modalId, modalTitle, inputId, inputLabel, inputStyle, currentValue,
    maxLength, minLength = 1, placeholder, validate, onSave,
}) {
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(modalTitle).addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId(inputId)
                .setLabel(inputLabel)
                .setStyle(inputStyle)
                .setValue(String(currentValue ?? ''))
                .setMaxLength(maxLength)
                .setMinLength(minLength)
                .setRequired(true)
                .setPlaceholder(placeholder),
        ),
    );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({ filter: (i) => i.customId === modalId && i.user.id === selectInteraction.user.id, time: 120_000 })
        .catch(() => null);
    if (!submitted) return;

    const value = submitted.fields.getTextInputValue(inputId).trim();

    const validationError = validate?.(value);
    if (validationError) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: validationError });
        return;
    }

    const resultEmbed = await onSave(value, submitted);
    await submitted.reply({ embeds: [resultEmbed], flags: MessageFlags.Ephemeral });
    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

const channelSelectMenu = (customId, placeholder) =>
    new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addChannelTypes(ChannelType.GuildText).setMaxValues(1);

const categorySelectMenu = (customId, placeholder) =>
    new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addChannelTypes(ChannelType.GuildCategory).setMaxValues(1);

// ---------------------------------------------------------------------------
// Individual setting handlers
// ---------------------------------------------------------------------------

const panelUpdateNote = (updated) =>
    updated
        ? '\nThe live ticket panel has also been refreshed.'
        : '\n> **Note:** The live panel could not be located. Use **Repost Panel** on the dashboard to restore it.';

async function handlePanelMessage(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runModalFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        modalId: 'ticket_cfg_panel_msg',
        modalTitle: '📝 Edit Panel Message',
        inputId: 'panel_msg_input',
        inputLabel: 'Panel Message',
        inputStyle: TextInputStyle.Paragraph,
        currentValue: guildConfig.ticketPanelMessage || 'Click the button below to create a support ticket.',
        maxLength: 2000,
        placeholder: 'Click the button below to create a support ticket.',
        onSave: async (value) => {
            guildConfig.ticketPanelMessage = value;
            await setGuildConfig(client, guildId, guildConfig);
            const updated = await updateLivePanel(client, rootInteraction.guild, guildConfig, guildId);
            return successEmbed('✅ Panel Message Updated', `The panel message has been updated.${panelUpdateNote(updated)}`);
        },
    });
}

async function handleButtonLabel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runModalFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        modalId: 'ticket_cfg_btn_label',
        modalTitle: '🏷️ Edit Button Label',
        inputId: 'btn_label_input',
        inputLabel: 'Button Label (max 80 characters)',
        inputStyle: TextInputStyle.Short,
        currentValue: guildConfig.ticketButtonLabel || 'Create Ticket',
        maxLength: 80,
        placeholder: 'Create Ticket',
        onSave: async (value) => {
            guildConfig.ticketButtonLabel = value;
            await setGuildConfig(client, guildId, guildConfig);
            const updated = await updateLivePanel(client, rootInteraction.guild, guildConfig, guildId);
            return successEmbed('✅ Button Label Updated', `Button label changed to \`${value}\`.${panelUpdateNote(updated)}`);
        },
    });
}

async function handleMaxTickets(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runModalFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        modalId: 'ticket_cfg_max_tickets',
        modalTitle: 'Set Max Tickets per User',
        inputId: 'max_tickets_input',
        inputLabel: 'Max Open Tickets (1–10)',
        inputStyle: TextInputStyle.Short,
        currentValue: guildConfig.maxTicketsPerUser || 3,
        maxLength: 2,
        placeholder: '3',
        validate: (raw) => {
            const value = parseInt(raw, 10);
            if (Number.isNaN(value) || value < 1 || value > 10) {
                return 'Max tickets must be a whole number between **1** and **10**.';
            }
            return null;
        },
        onSave: async (raw) => {
            const newMax = parseInt(raw, 10);
            guildConfig.maxTicketsPerUser = newMax;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('Max Tickets Updated', `Users can now have at most **${newMax}** open ticket${newMax !== 1 ? 's' : ''} at a time.`);
        },
    });
}

async function handleStaffRole(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runSelectFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        customId: 'ticket_cfg_staff_role',
        componentType: ComponentType.RoleSelect,
        menu: new RoleSelectMenuBuilder().setCustomId('ticket_cfg_staff_role').setPlaceholder('Select the staff role...').setMaxValues(1),
        embedTitle: '🛡️ Change Staff Role',
        embedDescription: `**Current:** ${guildConfig.ticketStaffRoleId ? `<@&${guildConfig.ticketStaffRoleId}>` : '\`Not set\`'}\n\nSelect the role that should have staff access to manage tickets.`,
        getSelected: (i) => i.roles.first(),
        onSave: async (role) => {
            guildConfig.ticketStaffRoleId = role.id;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('Staff Role Updated', `Staff role set to ${role}.`);
        },
        timeoutMessage: 'No role was selected. The staff role was not changed.',
    });
}

async function handleOpenCategory(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runSelectFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        customId: 'ticket_cfg_open_cat',
        componentType: ComponentType.ChannelSelect,
        menu: categorySelectMenu('ticket_cfg_open_cat', 'Select a category...'),
        embedTitle: '📁 Change Open Tickets Category',
        embedDescription: `**Current:** ${guildConfig.ticketCategoryId ? `<#${guildConfig.ticketCategoryId}>` : '\`Not set\`'}\n\nSelect the category where new tickets will be created.`,
        getSelected: (i) => i.channels.first(),
        onSave: async (category) => {
            guildConfig.ticketCategoryId = category.id;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('Open Category Updated', `New tickets will now be created in **${category.name}**.`);
        },
        timeoutMessage: 'No category was selected. The setting was not changed.',
    });
}

async function handleClosedCategory(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runSelectFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        customId: 'ticket_cfg_closed_cat',
        componentType: ComponentType.ChannelSelect,
        menu: categorySelectMenu('ticket_cfg_closed_cat', 'Select a category...'),
        embedTitle: '📂 Change Closed Tickets Category',
        embedDescription: `**Current:** ${guildConfig.ticketClosedCategoryId ? `<#${guildConfig.ticketClosedCategoryId}>` : '\`Not set\`'}\n\nSelect the category where closed tickets will be moved.`,
        getSelected: (i) => i.channels.first(),
        onSave: async (category) => {
            guildConfig.ticketClosedCategoryId = category.id;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('Closed Category Updated', `Closed tickets will now be moved to **${category.name}**.`);
        },
        timeoutMessage: 'No category was selected. The setting was not changed.',
    });
}

async function handleLogsChannel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runSelectFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        customId: 'ticket_cfg_logs_channel',
        componentType: ComponentType.ChannelSelect,
        menu: channelSelectMenu('ticket_cfg_logs_channel', 'Select a channel...'),
        embedTitle: '🎫 Select Ticket Logs Channel',
        embedDescription: 'Choose where ticket feedback, lifecycle events (open, close, claim, etc.), and other logs will be sent.',
        getSelected: (i) => i.channels.first(),
        onSave: async (channel) => {
            guildConfig.ticketLogsChannelId = channel.id;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('Logs Channel Updated', `Ticket logs will be sent to ${channel}`);
        },
        timeoutMessage: 'No channel selected. No changes were made.',
    });
}

async function handleAiLogsChannel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runSelectFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        customId: 'ticket_cfg_ai_logs_channel',
        componentType: ComponentType.ChannelSelect,
        menu: channelSelectMenu('ticket_cfg_ai_logs_channel', 'Select a channel...'),
        embedTitle: 'Select Ticket AI Logs Channel',
        embedDescription: 'Choose where player-report detections, missing-evidence updates, and ready-for-staff notices will be sent. You can also set this with `/ticket ai logs`.',
        getSelected: (i) => i.channels.first(),
        onSave: async (channel) => {
            guildConfig.ticketAiLogsChannelId = channel.id;
            guildConfig.ticketAiEnabled = true;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('AI Logs Channel Updated', `Ticket AI logs will be sent to ${channel}`);
        },
        timeoutMessage: 'No channel selected. No changes were made.',
    });
}

async function handleTranscriptChannel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await runSelectFlow({
        selectInteraction, rootInteraction, guildConfig, guildId, client,
        customId: 'ticket_cfg_transcript_channel',
        componentType: ComponentType.ChannelSelect,
        menu: channelSelectMenu('ticket_cfg_transcript_channel', 'Select a channel...'),
        embedTitle: '📜 Select Transcript Channel',
        embedDescription: 'Choose where auto-generated transcripts will be sent when tickets are deleted.',
        getSelected: (i) => i.channels.first(),
        onSave: async (channel) => {
            guildConfig.ticketTranscriptChannelId = channel.id;
            await setGuildConfig(client, guildId, guildConfig);
            return successEmbed('Transcript Channel Updated', `Transcripts will be sent to ${channel}`);
        },
        timeoutMessage: 'No channel selected. No changes were made.',
    });
}

async function handleDmOnClose(btnInteraction, rootInteraction, guildConfig, guildId, client) {
    await btnInteraction.deferUpdate();

    const newState = guildConfig.dmOnClose === false;
    guildConfig.dmOnClose = newState;
    await setGuildConfig(client, guildId, guildConfig);

    await btnInteraction.followUp({
        embeds: [successEmbed('DM on Close Updated', `Users will **${newState ? 'now' : 'no longer'}** receive a DM when their ticket is closed.`)],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleRepostPanel(btnInteraction, rootInteraction, guildConfig, guildId, client) {
    await btnInteraction.deferUpdate();

    const panelStatus = await getTicketPanelStatus(client, rootInteraction.guild, guildConfig);
    if (panelStatus.exists) {
        await btnInteraction
            .followUp({ embeds: [infoEmbed('Panel Already Active', 'The ticket panel is already posted in the configured channel.')], flags: MessageFlags.Ephemeral })
            .catch(() => {});
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
        return;
    }

    const sentPanel = await repostTicketPanel(client, rootInteraction.guild, guildConfig, guildId);

    await btnInteraction
        .followUp({
            embeds: [
                successEmbed(
                    'Panel Reposted',
                    `A new ticket panel was posted in <#${guildConfig.ticketPanelChannelId}>.${sentPanel.url ? `\n[Open panel message](${sentPanel.url})` : ''}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleDeleteSystem(btnInteraction, rootInteraction, guildConfig, guildId, client) {
    const deleteModal = new ModalBuilder().setCustomId('ticket_delete_confirm_modal').setTitle('Delete Ticket System').addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('delete_confirmation')
                .setLabel('Type "DELETE" to confirm')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('DELETE')
                .setMaxLength(6)
                .setMinLength(6)
                .setRequired(true),
        ),
    );

    await btnInteraction.showModal(deleteModal);

    const submitted = await btnInteraction
        .awaitModalSubmit({ filter: (i) => i.customId === 'ticket_delete_confirm_modal' && i.user.id === btnInteraction.user.id, time: 120_000 })
        .catch(() => null);

    if (!submitted) {
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
        return;
    }

    if (submitted.fields.getTextInputValue('delete_confirmation').trim() !== 'DELETE') {
        await replyUserError(submitted, { type: ErrorTypes.UNKNOWN, message: 'You must type "DELETE" exactly to confirm deletion.' });
        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
        return;
    }

    await submitted.deferUpdate();

    if (guildConfig.ticketPanelChannelId) {
        try {
            const panelChannel = await client.guilds.cache.get(guildId)?.channels.fetch(guildConfig.ticketPanelChannelId).catch(() => null);
            if (panelChannel) {
                if (guildConfig.ticketPanelMessageId) {
                    const panelMessage = await panelChannel.messages.fetch(guildConfig.ticketPanelMessageId).catch(() => null);
                    if (panelMessage) await panelMessage.delete().catch(() => {});
                } else {
                    const messages = await panelChannel.messages.fetch({ limit: 50 }).catch(() => null);
                    const found = messages?.find((m) => m.author.id === client.user.id && messageHasButtonCustomId(m, 'create_ticket'));
                    if (found) await found.delete().catch(() => {});
                }
            }
        } catch (panelDeleteError) {
            logger.warn('Could not delete ticket panel message:', panelDeleteError.message);
        }
    }

    try {
        const { pgConfig } = await import('../../../config/database/postgres.js');
        if (client.db?.db?.pool && client.db.db.isAvailable?.()) {
            await client.db.db.pool.query(`DELETE FROM ${pgConfig.tables.tickets} WHERE guild_id = $1`, [guildId]);
        }
    } catch (ticketDeleteError) {
        logger.warn('Could not clear ticket records from database:', ticketDeleteError.message);
    }

    for (const key of [
        'ticketPanelChannelId', 'ticketPanelMessageId', 'ticketStaffRoleId', 'ticketCategoryId',
        'ticketClosedCategoryId', 'ticketPanelMessage', 'ticketButtonLabel', 'maxTicketsPerUser', 'dmOnClose',
    ]) {
        delete guildConfig[key];
    }
    await setGuildConfig(client, guildId, guildConfig);

    await submitted.followUp({
        embeds: [successEmbed('✅ Ticket System Deleted', 'All ticket system configuration has been cleared. Run `/ticket setup` to set it up again.')],
        flags: MessageFlags.Ephemeral,
    });

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [new EmbedBuilder().setTitle('Ticket System Deleted').setDescription('The ticket system configuration has been cleared.').setColor(getColor('error')).setTimestamp()],
        components: [],
    }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SELECT_HANDLERS = {
    panel_message: handlePanelMessage,
    button_label: handleButtonLabel,
    open_category: handleOpenCategory,
    closed_category: handleClosedCategory,
    max_tickets: handleMaxTickets,
    logs_channel: handleLogsChannel,
    transcript_channel: handleTranscriptChannel,
    ai_logs_channel: handleAiLogsChannel,
};

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        try {
            const guildId = interaction.guild.id;
            const guildConfig = await getGuildConfig(client, guildId);

            if (!guildConfig.ticketPanelChannelId) {
                throw new TitanBotError(
                    'Ticket system not configured',
                    ErrorTypes.CONFIGURATION,
                    'The ticket system has not been set up yet. Run `/ticket setup` first to configure it.',
                );
            }

            const panelStatus = await getTicketPanelStatus(client, interaction.guild, guildConfig);
            if (panelStatus.recoveredId) {
                await persistPanelMessageId(client, guildId, guildConfig, panelStatus.recoveredId);
            }

            const ticketStats = await getGuildTicketStats(guildId);

            await startDashboardSession({
                interaction,
                embeds: [buildDashboardEmbed(guildConfig, interaction.guild, panelStatus, ticketStats)],
                components: [buildButtonRow(guildConfig, guildId, false, panelStatus), new ActionRowBuilder().addComponents(buildSelectMenu(guildId))],
                selectMenuId: `ticket_config_${guildId}`,
                buttonMatcher: (customId) =>
                    [
                        `ticket_cfg_repost_${guildId}`,
                        `ticket_cfg_dm_toggle_${guildId}`,
                        `ticket_cfg_staff_role_btn_${guildId}`,
                        `ticket_cfg_delete_${guildId}`,
                    ].includes(customId),
                onSelect: async (selectInteraction) => {
                    const handler = SELECT_HANDLERS[selectInteraction.values[0]];
                    if (handler) await handler(selectInteraction, interaction, guildConfig, guildId, client);
                },
                onButton: async (btnInteraction) => {
                    const id = btnInteraction.customId;
                    if (id === `ticket_cfg_repost_${guildId}`) await handleRepostPanel(btnInteraction, interaction, guildConfig, guildId, client);
                    else if (id === `ticket_cfg_dm_toggle_${guildId}`) await handleDmOnClose(btnInteraction, interaction, guildConfig, guildId, client);
                    else if (id === `ticket_cfg_staff_role_btn_${guildId}`) await handleStaffRole(btnInteraction, interaction, guildConfig, guildId, client);
                    else if (id === `ticket_cfg_delete_${guildId}`) await handleDeleteSystem(btnInteraction, interaction, guildConfig, guildId, client);
                },
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in ticket_config:', error);
            throw new TitanBotError(`Ticket config failed: ${error.message}`, ErrorTypes.UNKNOWN, 'Failed to open the ticket configuration dashboard.');
        }
    },
};

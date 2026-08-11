import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig, setGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { normalizeAiConfig, isAiConfigured, resolveHumanNotifyUserId } from '../../services/ticketAI/aiSupportService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import ticketConfig from './modules/ticket_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription("Manages the server's ticket system.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('setup')
                .setDescription('Sets up the ticket creation panel in a specified channel.')
                .addChannelOption((option) =>
                    option.setName('panel_channel').setDescription('The channel where the ticket panel will be sent.').addChannelTypes(ChannelType.GuildText).setRequired(true),
                )
                .addStringOption((option) => option.setName('panel_message').setDescription('The main message/description for the ticket panel.').setRequired(true))
                .addStringOption((option) => option.setName('button_label').setDescription('The label for the ticket creation button (default: Create Ticket)').setRequired(false))
                .addChannelOption((option) =>
                    option.setName('category').setDescription('The category where new tickets will be created (optional).').addChannelTypes(ChannelType.GuildCategory).setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName('closed_category')
                        .setDescription('The category where closed tickets will be moved (optional).')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addRoleOption((option) => option.setName('staff_role').setDescription('The role that can access tickets (optional).').setRequired(false))
                .addIntegerOption((option) =>
                    option.setName('max_tickets_per_user').setDescription('Maximum number of tickets a user can create (default: 3)').setMinValue(1).setMaxValue(10).setRequired(false),
                )
                .addBooleanOption((option) => option.setName('dm_on_close').setDescription('Send DM to user when their ticket is closed (default: true)').setRequired(false)),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('ai')
                .setDescription('Configure the ticket AI assistant and the "Request Human" escalation.')
                .addBooleanOption((option) => option.setName('enabled').setDescription('Let the AI assistant answer basic questions in tickets').setRequired(true))
                .addUserOption((option) => option.setName('notify_user').setDescription('User to ping when someone requests a human (optional override)').setRequired(false)),
        )
        .addSubcommand((subcommand) => subcommand.setName('dashboard').setDescription('Open the interactive ticket system dashboard')),
    category: 'ticket',

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            logger.warn('Ticket command permission denied', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'ticket' });
            return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the `Manage Channels` permission for this action.' });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'dashboard') {
            return ticketConfig.execute(interaction, config, client);
        }

        if (subcommand === 'ai') {
            return runAiConfig(interaction, client);
        }

        if (subcommand === 'setup') {
            return runSetup(interaction, client);
        }
    },
};

async function runAiConfig(interaction, client) {
    const enabled = interaction.options.getBoolean('enabled', true);
    const notifyUser = interaction.options.getUser('notify_user');

    const updates = { ticketAiEnabled: enabled };
    if (notifyUser) {
        updates.ticketAiNotifyUserId = notifyUser.id;
    }

    await updateGuildConfig(client, interaction.guildId, updates);

    const savedConfig = await getGuildConfig(client, interaction.guildId);
    const aiConfig = normalizeAiConfig();
    const effectiveNotifyUserId = resolveHumanNotifyUserId(savedConfig);

    const lines = [
        `**AI replies in tickets:** ${enabled ? '✅ Enabled' : '🚫 Disabled'}`,
        `**Request Human ping:** <@${effectiveNotifyUserId}>`,
    ];

    if (enabled && !isAiConfigured()) {
        lines.push('', '⚠️ **The AI cannot reply yet** — no `AI_API_KEY` is configured in the bot environment. Add one and restart the bot to activate the assistant. The "Request Human" button will still work.');
    } else if (enabled) {
        lines.push('', `**Model:** \`${aiConfig.model}\` — the assistant only answers questions in open tickets and stops when a human is requested.`);
    } else {
        lines.push('', 'New tickets will no longer show the AI/Request Human controls. Existing tickets keep their current controls.');
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket AI Settings Updated', lines.join('\n'))],
    });

    logger.info('Ticket AI configuration updated', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        enabled,
        notifyUserId: notifyUser?.id ?? null,
        commandName: 'ticket_ai',
    });
};

async function runSetup(interaction, client) {
    const existingConfig = await getGuildConfig(client, interaction.guildId);
    if (existingConfig?.ticketPanelChannelId) {
        return replyUserError(interaction, {
            type: ErrorTypes.UNKNOWN,
            message: `This server already has a ticket system set up (panel in <#${existingConfig.ticketPanelChannelId}>).\n\nOnly one ticket system is supported per server. Use \`/ticket dashboard\` to edit or update the existing setup, or select **Delete System** from the dashboard to remove it and start fresh.`,
        });
    }

    const panelChannel = interaction.options.getChannel('panel_channel');
    const categoryChannel = interaction.options.getChannel('category');
    const closedCategoryChannel = interaction.options.getChannel('closed_category');
    const staffRole = interaction.options.getRole('staff_role');
    const panelMessage = interaction.options.getString('panel_message') || 'Click the button below to create a support ticket.';
    const buttonLabel = interaction.options.getString('button_label') || 'Create Ticket';
    const maxTicketsPerUser = interaction.options.getInteger('max_tickets_per_user') || 3;
    const dmOnClose = interaction.options.getBoolean('dm_on_close') !== false;

    const ticketButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('create_ticket').setLabel(buttonLabel).setStyle(ButtonStyle.Primary).setEmoji('📩'),
    );

    try {
        const sentPanel = await panelChannel.send({
            embeds: [createEmbed({ title: 'Support Tickets', description: panelMessage, color: getColor('info') })],
            components: [ticketButton],
        });

        const logMeta = {
            guildId: interaction.guildId,
            categoryId: categoryChannel?.id,
            closedCategoryId: closedCategoryChannel?.id,
            staffRoleId: staffRole?.id,
            maxTickets: maxTicketsPerUser,
            dmOnClose,
        };

        if (client.db) {
            Object.assign(existingConfig, {
                ticketCategoryId: categoryChannel?.id || null,
                ticketClosedCategoryId: closedCategoryChannel?.id || null,
                ticketStaffRoleId: staffRole?.id || null,
                ticketPanelChannelId: panelChannel.id,
                ticketPanelMessageId: sentPanel?.id || null,
                ticketPanelMessage: panelMessage,
                ticketButtonLabel: buttonLabel,
                maxTicketsPerUser,
                dmOnClose,
            });

            await setGuildConfig(client, interaction.guildId, existingConfig);
            logger.info('Ticket configuration saved', logMeta);
        } else {
            logger.error('Ticket setup: database unavailable, panel sent but configuration was NOT saved', { guildId: interaction.guildId });
        }

        const summaryLines = [
            `The ticket creation panel has been sent to ${panelChannel}.`,
            categoryChannel ? `New tickets will be created in the **${categoryChannel.name}** category.` : 'New tickets will be created in a new "Tickets" category.',
            closedCategoryChannel ? `Closed tickets will be moved to **${closedCategoryChannel.name}**.` : null,
            staffRole ? `**${staffRole.name}** role will have access to tickets.` : null,
            `\n\n**Max Tickets Per User:** ${maxTicketsPerUser}\n**DM on Close:** ${dmOnClose ? 'Enabled' : 'Disabled'}`,
        ].filter(Boolean);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Ticket Panel Set Up', summaryLines.join(''))],
        });

        logger.info('Ticket panel setup completed', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            panelChannelId: panelChannel.id,
            commandName: 'ticket_setup',
            ...logMeta,
        });
    } catch (error) {
        logger.error('Ticket setup error', { error: error.message, stack: error.stack, userId: interaction.user.id, guildId: interaction.guildId, commandName: 'ticket_setup' });

        if (interaction.deferred || interaction.replied) {
            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: "Could not send the ticket panel or save configuration. Check the bot's permissions (especially the ability to send messages in the target channel) and database connection.",
            }).catch((err) => logger.error('Failed to send error reply', { error: err.message, guildId: interaction.guildId }));
        } else {
            await handleInteractionError(interaction, error, { commandName: 'ticket_setup', source: 'ticket_setup_command' });
        }
    }
};
// ticketAiActions.js — the (small, tightly-scoped) action layer for the ticket AI.
//
// The assistant is still answer-first, but it is now allowed to request exactly
// two side effects by emitting a sentinel token in its reply:
//
//   [[CLOSE_TICKET: reason]]  -> close the ticket once the issue is resolved
//   [[WARN_USER: reason]]     -> warn a user who is trolling/abusing the ticket
//
// Everything in the top half of this file is pure and unit tested. Only
// `applyAiTicketActions` touches Discord, and it re-validates every guard
// (permissions, hierarchy, warning count) before doing anything destructive.

import { logger } from '../../utils/logger.js';
import { logTicketEvent } from '../../utils/ticket/ticketLogging.js';

export const CLOSE_TICKET_TOKEN = '[[CLOSE_TICKET]]';
export const WARN_USER_TOKEN = '[[WARN_USER]]';

/** Number of warnings a user gets before the AI escalates to a kick. */
export const AI_WARNING_LIMIT = 3;

/** Matches `[[CLOSE_TICKET]]`, `[CLOSE TICKET]`, `[[close-ticket: solved]]`, … */
const CLOSE_TOKEN_PATTERN = /\[\[?\s*CLOSE[_\s-]?TICKET\s*(?::\s*([^\]]{0,300}))?\s*\]?\]/gi;
const WARN_TOKEN_PATTERN = /\[\[?\s*(?:WARN|WARNING)[_\s-]?USER\s*(?::\s*([^\]]{0,300}))?\s*\]?\]/gi;

function firstMatchReason(text, pattern) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    pattern.lastIndex = 0;
    if (!match) {
        return { found: false, reason: null };
    }
    const reason = (match[1] || '').trim();
    return { found: true, reason: reason || null };
}

/** Remove every action sentinel from a reply so users never see the raw token. */
export function stripActionTokens(text) {
    return String(text ?? '')
        .replace(CLOSE_TOKEN_PATTERN, '')
        .replace(WARN_TOKEN_PATTERN, '');
}

/**
 * Parse the action tokens out of a raw model reply.
 * Returns the requested actions plus the reply text with tokens removed.
 */
export function parseAiActions(rawReply) {
    const text = String(rawReply ?? '');
    const close = firstMatchReason(text, CLOSE_TOKEN_PATTERN);
    const warn = firstMatchReason(text, WARN_TOKEN_PATTERN);

    return {
        close: close.found,
        closeReason: close.reason,
        warn: warn.found,
        warnReason: warn.reason,
        text: stripActionTokens(text),
    };
}

/** Normalize the persisted warning list (older tickets may not have one). */
export function getAiWarnings(ticketData) {
    const raw = ticketData?.aiWarnings;
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((entry) => entry && typeof entry === 'object');
}

export function countAiWarningsForUser(ticketData, userId) {
    if (!userId) {
        return 0;
    }
    return getAiWarnings(ticketData).filter((entry) => String(entry.userId) === String(userId)).length;
}

function normalizeBehaviorText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/<@!?\d{17,20}>/g, ' user ')
        .replace(/https?:\/\/\S+/g, ' link ')
        .replace(/[^a-z0-9\s!?']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const CLEAR_TROLLING_PATTERNS = [
    /\b(?:i['’]?m|i am|we['’]?re|we are)\s+(?:just\s+)?(?:troll(?:ing)?|spam(?:ming)?|wast(?:ing|e)\s+(?:your|staff(?:'s)?|everyone['’]?s)?\s*time)\b/i,
    /\b(?:just|only)\s+(?:here\s+to\s+)?(?:troll(?:ing)?|spam(?:ming)?|wast(?:ing|e)\s+(?:your|staff(?:'s)?|everyone['’]?s)?\s*time)\b/i,
    /\b(?:this|the)\s+(?:ticket|support)\s+is\s+for\s+(?:trolling|spamming|wasting)\b/i,
];
const REPEATED_ABUSE_PATTERN = /\b(?:fuck|f+u+c+k+|shit|bitch|idiot|moron|stfu|shut\s+up)\b/i;

/**
 * Find behavior that is unambiguously deliberate ticket abuse without
 * penalising a single frustrated, confused, or rude message. The provider can
 * still request a warning for other cases with [[WARN_USER]], but this local
 * fallback keeps the warning system useful when a provider refuses to emit the
 * sentinel or no API key is configured.
 *
 * @param {{messages?: Array, ownerId?: string|null}} options
 * @returns {{warn: boolean, reason: string|null}}
 */
export function detectClearTrolling({ messages = [], ownerId = null } = {}) {
    // Never infer a moderation target when the ticket owner is unknown.
    if (!ownerId) {
        return { warn: false, reason: null };
    }

    const entries = (Array.isArray(messages) ? messages : [])
        .filter((message) => {
            if (!message || message.author?.bot) return false;
            return !ownerId || String(message.author?.id) === String(ownerId);
        })
        .map((message) => ({
            text: String(message.content || '').trim(),
            normalized: normalizeBehaviorText(message.content),
        }))
        .filter((message) => message.normalized);

    const latest = entries.at(-1);
    if (latest && CLEAR_TROLLING_PATTERNS.some((pattern) => pattern.test(latest.text))) {
        return { warn: true, reason: 'deliberate trolling or wasting support time' };
    }

    // Repeating the same non-question message three times in a short ticket is
    // a much safer signal than trying to classify ordinary insults. Only inspect
    // the ending of the conversation so one old burst cannot issue a new warning
    // on every later, unrelated message. Do not count one-word greetings or
    // questions as spam.
    const recent = entries.slice(-3);
    if (recent.length === 3) {
        const [first, second, third] = recent;
        if (
            first.normalized.length >= 4
            && first.normalized.length <= 240
            && first.normalized === second.normalized
            && second.normalized === third.normalized
            && !/[?]/.test(first.text)
        ) {
            return { warn: true, reason: 'repeated spam messages' };
        }

        if (
            recent.every((entry) => REPEATED_ABUSE_PATTERN.test(entry.text))
            && recent.every((entry) => !/[?]/.test(entry.text))
        ) {
            return { warn: true, reason: 'repeated abusive messages' };
        }
    }

    return { warn: false, reason: null };
}

/**
 * Decide what happens on the next trolling incident.
 * The user is only kicked once they have already received `limit` warnings,
 * which guarantees three warnings are always delivered before a kick.
 */
export function evaluateTrollOutcome({ previousWarnings = 0, limit = AI_WARNING_LIMIT } = {}) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : AI_WARNING_LIMIT;
    const previous = Number.isFinite(previousWarnings) && previousWarnings > 0 ? Math.floor(previousWarnings) : 0;

    if (previous >= safeLimit) {
        return {
            action: 'kick',
            warningNumber: previous,
            remaining: 0,
            limit: safeLimit,
        };
    }

    const warningNumber = previous + 1;
    return {
        action: 'warn',
        warningNumber,
        remaining: safeLimit - warningNumber,
        limit: safeLimit,
    };
}

export function buildWarningMessage({ warningNumber, limit = AI_WARNING_LIMIT, reason = null } = {}) {
    const remaining = Math.max(0, limit - warningNumber);
    const because = reason ? `\n**Reason:** ${String(reason).slice(0, 300)}` : '';
    const tail = remaining > 0
        ? `You have **${remaining}** warning${remaining === 1 ? '' : 's'} left before you are removed from the server.`
        : 'This is your **final warning** — the next incident will remove you from the server.';

    return `⚠️ **Warning ${warningNumber}/${limit}** — please keep this ticket on-topic and respectful.${because}\n\n${tail}`;
}

export function buildKickMessage({ limit = AI_WARNING_LIMIT, reason = null } = {}) {
    const because = reason ? `\n**Reason:** ${String(reason).slice(0, 300)}` : '';
    return `🚫 After **${limit}** warnings this ticket is still being misused, so the user has been removed from the server.${because}`;
}

export function buildAiCloseReason(reason) {
    const text = String(reason ?? '').trim();
    return text ? `AI assistant: ${text.slice(0, 300)}` : 'AI assistant: issue resolved';
}

/**
 * Guard rails for AI-initiated moderation. Staff, the bot itself, and members
 * the bot cannot act on are never touched.
 */
export function canAiModerateMember(member, { staffRoleId = null, botMemberId = null } = {}) {
    if (!member) {
        return { ok: false, reason: 'member-unavailable' };
    }
    if (member.user?.bot) {
        return { ok: false, reason: 'target-is-bot' };
    }
    if (botMemberId && member.id === botMemberId) {
        return { ok: false, reason: 'target-is-self' };
    }
    if (member.guild?.ownerId && member.guild.ownerId === member.id) {
        return { ok: false, reason: 'target-is-owner' };
    }
    if (staffRoleId && member.roles?.cache?.has?.(staffRoleId)) {
        return { ok: false, reason: 'target-is-staff' };
    }

    const perms = member.permissions;
    const isPrivileged = Boolean(
        perms?.has?.('Administrator')
        || perms?.has?.('ManageGuild')
        || perms?.has?.('ManageChannels')
        || perms?.has?.('KickMembers')
        || perms?.has?.('ModerateMembers'),
    );
    if (isPrivileged) {
        return { ok: false, reason: 'target-is-staff' };
    }

    if (member.kickable === false) {
        return { ok: false, reason: 'not-kickable' };
    }

    return { ok: true, reason: null };
}

/**
 * Only the ticket creator can be moderated by the AI, and only inside their own
 * ticket. This keeps the blast radius of a hallucinated token to zero.
 */
export function resolveModerationTargetId(ticketData, { lastAuthorId = null } = {}) {
    const ownerId = ticketData?.userId || null;
    if (!ownerId) {
        return null;
    }
    if (lastAuthorId && lastAuthorId !== ownerId) {
        return null;
    }
    return ownerId;
}

// ---------------------------------------------------------------------------
// Execution (Discord side)
// ---------------------------------------------------------------------------

async function recordWarning({ client, guildId, userId, reason }) {
    try {
        const { WarningService } = await import('../moderation/warningService.js');
        await WarningService.addWarning({
            guildId,
            userId,
            moderatorId: client?.user?.id || 'ai-assistant',
            reason: `[AI ticket assistant] ${reason || 'Trolling in a support ticket'}`,
        });
    } catch (error) {
        logger.warn('Ticket AI: could not persist warning to the warning service', {
            guildId,
            userId,
            error: error.message,
        });
    }
}

/**
 * Execute the actions the model asked for.
 *
 * @returns {Promise<{closed: boolean, warned: boolean, kicked: boolean, notices: string[]}>}
 */
export async function applyAiTicketActions({
    channel,
    client,
    ticketData,
    guildConfig = {},
    actions,
    lastAuthorId = null,
    warningLimit = AI_WARNING_LIMIT,
    allowClose = true,
    allowModeration = true,
    sendNotice = null,
}) {
    const result = { closed: false, warned: false, kicked: false, notices: [] };
    if (!actions || !channel?.guild) {
        return result;
    }

    const guildId = channel.guild.id;
    const ticketNumber = ticketData?.number || ticketData?.id || channel.id;

    const notify = async (text) => {
        result.notices.push(text);
        if (typeof sendNotice === 'function') {
            await sendNotice(text);
        }
    };

    // ---------------------------------------------------------------- warn/kick
    if (actions.warn && allowModeration) {
        const targetId = resolveModerationTargetId(ticketData, { lastAuthorId });
        if (!targetId) {
            logger.debug('Ticket AI: warn requested but no valid target', { channelId: channel.id });
        } else {
            const member = await channel.guild.members.fetch(targetId).catch(() => null);
            const guard = canAiModerateMember(member, {
                staffRoleId: guildConfig?.ticketStaffRoleId || null,
                botMemberId: client?.user?.id || null,
            });

            if (!guard.ok) {
                logger.info('Ticket AI: moderation skipped', {
                    channelId: channel.id,
                    targetId,
                    reason: guard.reason,
                });
            } else {
                const previous = countAiWarningsForUser(ticketData, targetId);
                const outcome = evaluateTrollOutcome({ previousWarnings: previous, limit: warningLimit });

                if (outcome.action === 'warn') {
                    ticketData.aiWarnings = [
                        ...getAiWarnings(ticketData),
                        {
                            userId: targetId,
                            reason: actions.warnReason || null,
                            at: new Date().toISOString(),
                            number: outcome.warningNumber,
                        },
                    ];
                    result.warned = true;

                    await recordWarning({ client, guildId, userId: targetId, reason: actions.warnReason });
                    await notify(buildWarningMessage({
                        warningNumber: outcome.warningNumber,
                        limit: outcome.limit,
                        reason: actions.warnReason,
                    }));

                    await logTicketEvent({
                        client,
                        guildId,
                        event: {
                            type: 'ai_warn',
                            ticketId: channel.id,
                            ticketNumber,
                            userId: targetId,
                            reason: actions.warnReason || 'Trolling / misuse of the ticket',
                            metadata: {
                                warningNumber: outcome.warningNumber,
                                warningLimit: outcome.limit,
                            },
                        },
                    });
                } else {
                    // Three warnings already delivered — remove the user.
                    try {
                        const { ModerationService } = await import('../moderation/moderationService.js');
                        await ModerationService.kickUser({
                            guild: channel.guild,
                            member,
                            moderator: channel.guild.members.me,
                            reason: `AI ticket assistant: ${actions.warnReason || 'repeated trolling'} (after ${outcome.limit} warnings)`,
                        });
                        result.kicked = true;
                        ticketData.aiKickedUserId = targetId;
                        ticketData.aiKickedAt = new Date().toISOString();

                        await notify(buildKickMessage({ limit: outcome.limit, reason: actions.warnReason }));

                        await logTicketEvent({
                            client,
                            guildId,
                            event: {
                                type: 'ai_kick',
                                ticketId: channel.id,
                                ticketNumber,
                                userId: targetId,
                                reason: actions.warnReason || 'Repeated trolling after warnings',
                                metadata: { warningLimit: outcome.limit },
                            },
                        });
                    } catch (error) {
                        logger.warn('Ticket AI: kick failed', {
                            channelId: channel.id,
                            targetId,
                            error: error.message,
                        });
                        await notify(
                            'This ticket keeps getting misused, but I was not able to remove the user. '
                            + 'Staff have been asked to take a look.',
                        );
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------- close
    if (actions.close && allowClose && !result.kicked) {
        try {
            const { closeTicket } = await import('../ticket.js');
            const closer = client?.user
                ? { id: client.user.id, tag: `${client.user.username} (AI assistant)`, toString: () => `<@${client.user.id}>` }
                : { id: 'ai-assistant', tag: 'AI assistant', toString: () => 'the AI assistant' };

            await closeTicket(channel, closer, buildAiCloseReason(actions.closeReason));
            result.closed = true;

            await logTicketEvent({
                client,
                guildId,
                event: {
                    type: 'ai_close',
                    ticketId: channel.id,
                    ticketNumber,
                    userId: ticketData?.userId || null,
                    executorId: client?.user?.id || null,
                    reason: buildAiCloseReason(actions.closeReason),
                },
            });
        } catch (error) {
            logger.warn('Ticket AI: close failed', { channelId: channel.id, error: error.message });
        }
    } else if (actions.close && result.kicked) {
        logger.debug('Ticket AI: skipped close because a kick was just executed', { channelId: channel.id });
    }

    return result;
}

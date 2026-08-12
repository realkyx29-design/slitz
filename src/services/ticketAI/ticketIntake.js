// Structured ticket intake — greets on create, collects player-report
// evidence (username + video), and logs progress to the AI logs channel.
// Does not need an LLM; the chat model is only used for general Q&A.

import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { saveTicketData } from '../../utils/database.js';
import { logTicketEvent } from '../../utils/ticket/ticketLogging.js';

export const INTAKE_FOOTER_TAG = 'AI Assistant';

export const TICKET_KINDS = {
    PLAYER_REPORT: 'player_report',
    GENERAL: 'general',
};

const PLAYER_REPORT_PHRASES = [
    'player report',
    'report a player',
    'reporting a player',
    'report player',
    'user report',
    'report a user',
    'reporting a user',
    'report this player',
    'report this user',
    'report this guy',
    'i want to report',
    'id like to report',
    "i'd like to report",
    'filing a report',
    'make a report',
    'cheating',
    'cheater',
    'hacker',
    'hacking',
    'aimbot',
    'wallhack',
    'using hacks',
    'using cheats',
    'rdm',
    'vdm',
    'team killing',
    'teamkiller',
    'harassment',
    'harassing',
    'hate speech',
    'slur',
    'toxic player',
    'rule break',
    'broke the rules',
    'breaking rules',
    'combat logging',
    'stream sniping',
    'greifing',
    'griefing',
    'stole my',
    'scammed',
    'scammer',
];

const USERNAME_STOP_WORDS = new Set([
    'the', 'this', 'that', 'they', 'them', 'him', 'her', 'his', 'she', 'he',
    'player', 'user', 'someone', 'somebody', 'guy', 'dude', 'person', 'people',
    'cheater', 'hacker', 'mod', 'admin', 'staff', 'here', 'there', 'please',
    'report', 'reporting', 'video', 'clip', 'proof', 'evidence', 'username',
    'name', 'ign', 'discord', 'server', 'ticket',
]);

const USERNAME_PATTERNS = [
    /(?:user(?: ?name)?|ign|gamertag|gamer ?tag|player(?: ?name)?|reported(?: user| player)?|reporting|name)\s*(?:is|=|:|-|–)\s*[@"]?([A-Za-z0-9_.\- ]{2,32})["']?/i,
    /(?:reporting|report(?:ing)?)\s+[@"]?([A-Za-z0-9_.\-]{2,32})/i,
    /(?:their|his|her)\s+(?:user ?name|ign|name)\s+(?:is\s+)?[@"]?([A-Za-z0-9_.\-]{2,32})/i,
];

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|mkv|avi|m4v)(?:\?|$)/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)(?:\?|$)/i;

const VIDEO_URL_RE = /https?:\/\/(?:(?:www\.)?(?:youtube\.com|youtu\.be|streamable\.com|medal\.tv|(?:clips\.)?twitch\.tv|tiktok\.com|vm\.tiktok\.com|vimeo\.com|kick\.com|loom\.com|gyazo\.com|imgur\.com|streamlabs\.com)\/\S+|(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\S+)/gi;

const MENTION_RE = /<@!?(\d{17,20})>/g;
const AT_HANDLE_RE = /(?<!\w)@([A-Za-z0-9_.]{2,32})/g;

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * "How do I report a player?" is a support question, not a filed report.
 * Treating those as player reports made the bot nag for a username/video
 * instead of answering.
 */
export function isHowToReportQuestion(text) {
    const haystack = String(text || '').toLowerCase();
    if (!haystack) return false;
    const asksHow = /\b(how (do i|can i|to|does one|would i)|what (do i need|should i|is the)|where (do i|can i)|can you (help|tell|explain)|help me|i (need|want) (help|to know))\b/.test(haystack);
    return asksHow && /\breport/.test(haystack);
}

export function isPlayerReportText(text) {
    const haystack = String(text || '').toLowerCase();
    if (!haystack) return false;
    if (isHowToReportQuestion(haystack)) return false;
    if (/\breport(ing|ed)?\b/.test(haystack) && /\b(player|user|him|her|them|this guy|this person)\b/.test(haystack)) {
        return true;
    }
    return PLAYER_REPORT_PHRASES.some((phrase) => haystack.includes(phrase));
}

/** True when the user is asking something rather than just dumping report evidence. */
export function looksLikeSupportQuestion(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (/\?/.test(raw)) return true;
    const t = raw.toLowerCase();
    if (/^(how|what|why|when|where|who|which|can|could|would|do|does|did|is|are|am|will|should|may|help|please|yo|hey|hi|hello)\b/.test(t)) {
        return true;
    }
    return /\b(how (do|can|to|does)|what (is|are|does|do)|can you|could you|please (help|tell|explain|answer)|i (need|want) (help|to know|to ask)|i have a question)\b/.test(t);
}

export function latestUserMessageText(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const message = list[i];
        if (message?.author?.bot) continue;
        const text = normalizeText(message?.content || '');
        if (text) return text;
    }
    return '';
}

/**
 * Only send the canned username/video checklist when the user actually
 * supplied new report evidence. Questions always go to the chat model.
 */
export function shouldSendIntakeFollowUp({ previous = null, analysis = null, latestUserText = '' } = {}) {
    if (!analysis?.isPlayerReport) return false;

    const askedQuestion = looksLikeSupportQuestion(latestUserText);
    const justCompleted = Boolean(analysis.complete && !previous?.complete);
    const hadUsername = Boolean(previous?.reportedUsername);
    const hadVideo = Boolean(previous?.hasVideo || (previous?.videoUrls || []).length);
    const newUsername = Boolean(analysis.reportedUsername && !hadUsername);
    const newVideo = Boolean(analysis.hasVideo && !hadVideo);

    if (askedQuestion) return false;
    if (justCompleted) return true;
    if (newUsername || newVideo) return true;
    return false;
}

export function detectTicketKind({ reason = '', texts = [] } = {}) {
    const combined = [reason, ...texts].filter(Boolean).join('\n');
    return isPlayerReportText(combined) ? TICKET_KINDS.PLAYER_REPORT : TICKET_KINDS.GENERAL;
}

function isLikelyUsername(value) {
    const name = normalizeText(value);
    if (!name || name.length < 2 || name.length > 32) return false;
    const lowered = name.toLowerCase();
    if (USERNAME_STOP_WORDS.has(lowered)) return false;
    if (!/^[A-Za-z0-9_.\- ]+$/.test(name)) return false;
    if (/^\d{17,20}$/.test(name)) return false;
    if (/\s{2,}/.test(name)) return false;
    const words = name.split(' ');
    if (words.length > 3) return false;
    return true;
}

export function extractReportedUsername(text, { ticketOwnerId = null } = {}) {
    const raw = String(text || '');
    if (!raw.trim()) return null;

    for (const match of raw.matchAll(MENTION_RE)) {
        if (match[1] && match[1] !== ticketOwnerId) {
            return `<@${match[1]}>`;
        }
    }

    // Strip mentions so "<@id>" is not parsed as "@id" / a numeric username.
    const withoutMentions = raw.replace(MENTION_RE, ' ');

    for (const pattern of USERNAME_PATTERNS) {
        const match = withoutMentions.match(pattern);
        if (match?.[1]) {
            const candidate = match[1].replace(/[.,!?;:]+$/, '').trim();
            if (isLikelyUsername(candidate)) {
                return candidate;
            }
        }
    }

    for (const match of withoutMentions.matchAll(AT_HANDLE_RE)) {
        if (isLikelyUsername(match[1])) {
            return match[1];
        }
    }

    return null;
}

export function isVideoAttachment(attachment) {
    if (!attachment) return false;
    const type = String(attachment.contentType || attachment.content_type || '').toLowerCase();
    if (type.startsWith('video/')) return true;
    const name = String(attachment.name || attachment.filename || attachment.url || '');
    return VIDEO_EXTENSIONS.test(name);
}

export function isImageAttachment(attachment) {
    if (!attachment) return false;
    const type = String(attachment.contentType || attachment.content_type || '').toLowerCase();
    if (type.startsWith('image/')) return true;
    const name = String(attachment.name || attachment.filename || attachment.url || '');
    return IMAGE_EXTENSIONS.test(name);
}

export function extractVideoLinks(text) {
    const raw = String(text || '');
    if (!raw) return [];
    const found = raw.match(VIDEO_URL_RE) || [];
    return [...new Set(found.map((url) => url.replace(/[),.;]+$/, '')))].filter((url) => {
        if (VIDEO_EXTENSIONS.test(url)) return true;
        // Discord image CDNs are not videos unless they have a video extension.
        if (/discordapp\.(?:com|net)\/attachments\//i.test(url) && !VIDEO_EXTENSIONS.test(url)) {
            return false;
        }
        return true;
    });
}

function listFromCollection(collection) {
    if (!collection) return [];
    if (typeof collection.values === 'function') return [...collection.values()];
    if (Array.isArray(collection)) return collection;
    return Object.values(collection);
}

function messageTextsAndFiles(message) {
    const content = message?.content || '';
    const attachments = listFromCollection(message?.attachments);
    const videos = [];
    const images = [];

    for (const attachment of attachments) {
        if (isVideoAttachment(attachment)) {
            videos.push(attachment.url || attachment.name || 'uploaded video');
        } else if (isImageAttachment(attachment)) {
            images.push(attachment.url || attachment.name || 'uploaded image');
        }
    }

    videos.push(...extractVideoLinks(content));

    return {
        content: normalizeText(content),
        videos: [...new Set(videos)],
        images: [...new Set(images)],
        authorId: message?.author?.id || null,
        isBot: Boolean(message?.author?.bot),
    };
}

export function analyzeTicketIntake({
    reason = '',
    messages = [],
    ticketOwnerId = null,
    previous = null,
} = {}) {
    const userMessages = (Array.isArray(messages) ? messages : [])
        .map(messageTextsAndFiles)
        .filter((entry) => !entry.isBot);

    const texts = [
        reason,
        ...userMessages.map((entry) => entry.content).filter(Boolean),
    ];

    const kind = previous?.kind === TICKET_KINDS.PLAYER_REPORT
        ? TICKET_KINDS.PLAYER_REPORT
        : detectTicketKind({ reason, texts });

    let reportedUsername = previous?.reportedUsername || null;
    if (!reportedUsername) {
        reportedUsername = extractReportedUsername(reason, { ticketOwnerId });
    }
    if (!reportedUsername) {
        for (const entry of userMessages) {
            reportedUsername = extractReportedUsername(entry.content, { ticketOwnerId });
            if (reportedUsername) break;
        }
    }

    const videos = [
        ...(previous?.videoUrls || []),
        ...userMessages.flatMap((entry) => entry.videos),
        ...extractVideoLinks(reason),
    ];
    const images = [
        ...(previous?.imageUrls || []),
        ...userMessages.flatMap((entry) => entry.images),
    ];

    const uniqueVideos = [...new Set(videos.filter(Boolean))];
    const uniqueImages = [...new Set(images.filter(Boolean))];

    const descriptionSource = texts
        .map((text) => normalizeText(text))
        .find((text) => text.length >= 12 && !/^(report|player report|help)$/i.test(text)) || '';

    const missing = [];
    if (kind === TICKET_KINDS.PLAYER_REPORT) {
        if (!reportedUsername) missing.push('username');
        if (uniqueVideos.length === 0) missing.push('video');
    }

    return {
        kind,
        isPlayerReport: kind === TICKET_KINDS.PLAYER_REPORT,
        reportedUsername,
        videoUrls: uniqueVideos,
        imageUrls: uniqueImages,
        hasVideo: uniqueVideos.length > 0,
        hasImage: uniqueImages.length > 0,
        hasDescription: descriptionSource.length >= 12,
        description: descriptionSource.slice(0, 400),
        missing,
        complete: kind === TICKET_KINDS.PLAYER_REPORT ? missing.length === 0 : true,
    };
}

export function evidenceFingerprint(analysis) {
    return [
        analysis?.kind || 'general',
        analysis?.reportedUsername || '',
        analysis?.hasVideo ? 'video' : '',
        analysis?.hasImage ? 'image' : '',
        analysis?.complete ? 'ready' : 'open',
    ].join('|');
}

function checklistLines(analysis) {
    const username = analysis.reportedUsername
        ? `✅ Player username: **${analysis.reportedUsername}**`
        : '❌ Player **username** (or a Discord mention)';
    const video = analysis.hasVideo
        ? `✅ Video evidence attached`
        : '❌ A **video** of what happened (upload it here, or paste a YouTube / Medal / Streamable / Twitch clip link)';
    const extra = analysis.hasImage && !analysis.hasVideo
        ? 'ℹ️ Screenshot received — a video is still required.'
        : null;
    return [username, video, extra].filter(Boolean);
}

export function buildIntakeGreeting(analysis) {
    if (analysis?.isPlayerReport) {
        return [
            "Thanks for opening this ticket — this looks like a **player report**.",
            "I'll collect the details so staff can review it quickly.",
            '',
            'Please send **all** of the following in this channel:',
            ...checklistLines(analysis).map((line) => `• ${line}`),
            '',
            'A short description of what they did also helps.',
            'Need a staff member right away? Press **🧑‍💼 Request Human**.',
        ].join('\n');
    }

    return [
        "Hi — I'm the AI assistant for this ticket and I'll reply here automatically.",
        'Tell me what you need help with and I will answer what I can.',
        'If this is a **player report**, send the player\'s **username** and a **video** of what happened.',
        'Need a real person? Press **🧑‍💼 Request Human** anytime.',
    ].join('\n');
}

export function buildIntakeFollowUp(analysis) {
    if (!analysis?.isPlayerReport) {
        return null;
    }

    if (analysis.complete) {
        return [
            `Got everything I need — username **${analysis.reportedUsername}** and video evidence.`,
            "I've logged this player report for staff. They'll review it shortly.",
            'If you have more clips or details, send them here. Otherwise you can wait for a staff member, or press **🧑‍💼 Request Human**.',
        ].join('\n');
    }

    const saved = [];
    if (analysis.reportedUsername) saved.push(`username **${analysis.reportedUsername}**`);
    if (analysis.hasVideo) saved.push('video evidence');
    if (analysis.hasImage && !analysis.hasVideo) saved.push('a screenshot');

    return [
        saved.length ? `Thanks — I saved ${saved.join(' and ')}.` : 'I still need a couple of things before staff can act on this report.',
        '',
        'Still needed:',
        ...checklistLines(analysis).map((line) => `• ${line}`),
        '',
        'Upload the video in this ticket or paste a clip link. Mentions like `@player` work for the username too.',
    ].join('\n');
}

export function mergeIntakeState(previous, analysis) {
    return {
        kind: analysis.kind,
        reportedUsername: analysis.reportedUsername || previous?.reportedUsername || null,
        videoUrls: analysis.videoUrls || [],
        imageUrls: analysis.imageUrls || [],
        hasVideo: Boolean(analysis.hasVideo),
        hasImage: Boolean(analysis.hasImage),
        hasDescription: Boolean(analysis.hasDescription),
        complete: Boolean(analysis.complete),
        loggedInitial: Boolean(previous?.loggedInitial),
        loggedComplete: Boolean(previous?.loggedComplete),
        lastFingerprint: previous?.lastFingerprint || null,
    };
}

export async function sendIntakeEmbed(channel, description) {
    const embed = createEmbed({
        title: `🤖 ${INTAKE_FOOTER_TAG}`,
        description,
        color: 'primary',
        footer: { text: `🤖 ${INTAKE_FOOTER_TAG} • automated reply — not a staff member` },
    });

    return channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error) => {
        logger.warn('Ticket intake: failed to send message', {
            channelId: channel?.id,
            message: error.message,
        });
        return null;
    });
}

function resolveAiLogChannelId(guildConfig) {
    return guildConfig?.ticketAiLogsChannelId || null;
}

export async function logTicketAiIntake({
    client,
    guildId,
    ticketData,
    analysis,
    eventType,
    executorId = null,
}) {
    if (!client || !guildId || !analysis) return false;

    await logTicketEvent({
        client,
        guildId,
        event: {
            type: eventType,
            ticketId: ticketData?.id,
            ticketNumber: ticketData?.id,
            userId: ticketData?.userId,
            executorId: executorId || ticketData?.userId,
            reason: ticketData?.reason || analysis.description || null,
            metadata: {
                kind: analysis.kind,
                reportedUsername: analysis.reportedUsername,
                hasVideo: analysis.hasVideo,
                hasImage: analysis.hasImage,
                videoUrls: (analysis.videoUrls || []).slice(0, 5),
                imageUrls: (analysis.imageUrls || []).slice(0, 3),
                missing: analysis.missing,
                complete: analysis.complete,
                description: analysis.description || null,
            },
        },
    });
    return true;
}

export async function persistIntakeState(guildId, channelId, ticketData, intakeState) {
    if (!ticketData) return ticketData;
    ticketData.aiIntake = intakeState;
    try {
        await saveTicketData(guildId, channelId, ticketData);
    } catch (error) {
        logger.warn('Ticket intake: failed to save state', { channelId, error: error.message });
    }
    return ticketData;
}

export async function startTicketAiIntake({ channel, ticketData, guildConfig, client }) {
    if (!channel || !ticketData) return null;

    const analysis = analyzeTicketIntake({
        reason: ticketData.reason || '',
        messages: [],
        ticketOwnerId: ticketData.userId,
        previous: ticketData.aiIntake || null,
    });

    const greeting = buildIntakeGreeting(analysis);
    const sent = await sendIntakeEmbed(channel, greeting);
    if (!sent) return analysis;

    ticketData.aiReplyCount = (ticketData.aiReplyCount || 0) + 1;
    ticketData.aiLastReplyAt = new Date().toISOString();

    const state = mergeIntakeState(ticketData.aiIntake, analysis);
    const fingerprint = evidenceFingerprint(analysis);

    if (analysis.isPlayerReport && resolveAiLogChannelId(guildConfig) && !state.loggedInitial) {
        await logTicketAiIntake({
            client,
            guildId: channel.guild.id,
            ticketData,
            analysis,
            eventType: 'ai_player_report',
        });
        state.loggedInitial = true;
        state.lastFingerprint = fingerprint;
    }

    if (analysis.isPlayerReport && analysis.complete && resolveAiLogChannelId(guildConfig) && !state.loggedComplete) {
        await logTicketAiIntake({
            client,
            guildId: channel.guild.id,
            ticketData,
            analysis,
            eventType: 'ai_player_report_ready',
        });
        state.loggedComplete = true;
        state.lastFingerprint = fingerprint;
    }

    await persistIntakeState(channel.guild.id, channel.id, ticketData, state);
    return analysis;
}

export async function syncTicketIntake({
    channel,
    ticketData,
    guildConfig,
    client,
    messages = [],
}) {
    if (!ticketData) {
        return { analysis: null, followUp: null, shouldUseTemplate: false };
    }

    const previous = ticketData.aiIntake || null;
    const analysis = analyzeTicketIntake({
        reason: ticketData.reason || '',
        messages,
        ticketOwnerId: ticketData.userId,
        previous,
    });

    const state = mergeIntakeState(previous, analysis);
    const fingerprint = evidenceFingerprint(analysis);
    const logChannelReady = Boolean(resolveAiLogChannelId(guildConfig));

    if (analysis.isPlayerReport && logChannelReady && !state.loggedInitial) {
        await logTicketAiIntake({
            client,
            guildId: channel.guild.id,
            ticketData,
            analysis,
            eventType: 'ai_player_report',
        });
        state.loggedInitial = true;
        state.lastFingerprint = fingerprint;
    } else if (
        analysis.isPlayerReport
        && logChannelReady
        && state.loggedInitial
        && !analysis.complete
        && fingerprint !== state.lastFingerprint
    ) {
        await logTicketAiIntake({
            client,
            guildId: channel.guild.id,
            ticketData,
            analysis,
            eventType: 'ai_player_report_update',
        });
        state.lastFingerprint = fingerprint;
    }

    if (analysis.isPlayerReport && analysis.complete && logChannelReady && !state.loggedComplete) {
        await logTicketAiIntake({
            client,
            guildId: channel.guild.id,
            ticketData,
            analysis,
            eventType: 'ai_player_report_ready',
        });
        state.loggedComplete = true;
        state.lastFingerprint = fingerprint;
    }

    await persistIntakeState(channel.guild.id, channel.id, ticketData, state);

    const latestUserText = latestUserMessageText(messages);
    const shouldUseTemplate = shouldSendIntakeFollowUp({
        previous,
        analysis,
        latestUserText,
    });
    return {
        analysis,
        followUp: shouldUseTemplate ? buildIntakeFollowUp(analysis) : null,
        shouldUseTemplate,
        latestUserText,
    };
}

export function describeIntakeForPrompt(analysis) {
    const isReport = Boolean(analysis?.isPlayerReport || analysis?.kind === TICKET_KINDS.PLAYER_REPORT);
    if (!isReport) return null;
    const missing = Array.isArray(analysis.missing)
        ? analysis.missing
        : [
            analysis.reportedUsername ? null : 'username',
            analysis.hasVideo ? null : 'video',
        ].filter(Boolean);
    const status = analysis.complete
        ? 'The player report is complete (username + video collected). Answer the user\'s latest message normally.'
        : `This is a player report still missing: ${missing.join(', ') || 'nothing'}. If the user asked a question, answer that question first. Only then you may briefly mention any missing username or video. Never ignore their message to demand those items.`;
    const known = [
        analysis.reportedUsername ? `Reported username: ${analysis.reportedUsername}` : 'Reported username: not provided yet',
        analysis.hasVideo ? 'Video evidence: provided' : 'Video evidence: missing',
    ];
    return `${status}\n${known.join('\n')}`;
}

export { resolveAiLogChannelId };

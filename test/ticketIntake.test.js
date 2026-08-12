import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const {
    TICKET_KINDS,
    isPlayerReportText,
    isHowToReportQuestion,
    detectTicketKind,
    extractReportedUsername,
    extractVideoLinks,
    isVideoAttachment,
    isImageAttachment,
    analyzeTicketIntake,
    buildIntakeGreeting,
    buildIntakeFollowUp,
    evidenceFingerprint,
    mergeIntakeState,
    describeIntakeForPrompt,
    looksLikeSupportQuestion,
    latestUserMessageText,
    shouldSendIntakeFollowUp,
} = await import('../src/services/ticketAI/ticketIntake.js');

test('detects player reports from common phrasing', () => {
    assert.equal(isPlayerReportText('I want to report a player'), true);
    assert.equal(isPlayerReportText('This guy is cheating with an aimbot'), true);
    assert.equal(isPlayerReportText('reporting ToxicKid for rdm'), true);
    assert.equal(isPlayerReportText('how do I join the discord?'), false);
    assert.equal(detectTicketKind({ reason: 'Player report: hacking' }), TICKET_KINDS.PLAYER_REPORT);
    assert.equal(detectTicketKind({ reason: 'Need help with roles' }), TICKET_KINDS.GENERAL);
});

test('how-to-report questions are not treated as a filed player report', () => {
    assert.equal(isHowToReportQuestion('how do I report a player?'), true);
    assert.equal(isHowToReportQuestion('what do I need to report someone'), true);
    assert.equal(isHowToReportQuestion('I want to report a player named Joe'), false);
    assert.equal(isPlayerReportText('how do I report a player?'), false);
    assert.equal(isPlayerReportText('how can I report someone for cheating'), false);
    assert.equal(detectTicketKind({ texts: ['how do I report a player?'] }), TICKET_KINDS.GENERAL);
});

test('looksLikeSupportQuestion detects real questions vs evidence dumps', () => {
    assert.equal(looksLikeSupportQuestion('how do I get VIP?'), true);
    assert.equal(looksLikeSupportQuestion('what are the server rules'), true);
    assert.equal(looksLikeSupportQuestion('can you help me with roles'), true);
    assert.equal(looksLikeSupportQuestion('username: ToxicKid'), false);
    assert.equal(looksLikeSupportQuestion('https://medal.tv/games/123'), false);
});

test('shouldSendIntakeFollowUp never hijacks a question with the checklist', () => {
    const incompleteReport = {
        isPlayerReport: true,
        complete: false,
        reportedUsername: null,
        hasVideo: false,
        missing: ['username', 'video'],
    };

    assert.equal(shouldSendIntakeFollowUp({
        previous: { kind: TICKET_KINDS.PLAYER_REPORT },
        analysis: incompleteReport,
        latestUserText: 'how do I appeal a ban?',
    }), false);

    assert.equal(shouldSendIntakeFollowUp({
        previous: { kind: TICKET_KINDS.PLAYER_REPORT },
        analysis: incompleteReport,
        latestUserText: 'I still need help with roles',
    }), false);

    assert.equal(shouldSendIntakeFollowUp({
        previous: { kind: TICKET_KINDS.PLAYER_REPORT, reportedUsername: null },
        analysis: { ...incompleteReport, reportedUsername: 'ToxicKid', missing: ['video'] },
        latestUserText: 'username: ToxicKid',
    }), true);

    assert.equal(shouldSendIntakeFollowUp({
        previous: { kind: TICKET_KINDS.PLAYER_REPORT, reportedUsername: 'ToxicKid' },
        analysis: {
            isPlayerReport: true,
            complete: true,
            reportedUsername: 'ToxicKid',
            hasVideo: true,
            missing: [],
        },
        latestUserText: 'https://youtu.be/abcd1234',
    }), true);

    assert.equal(latestUserMessageText([
        { author: { bot: true }, content: 'Hi I need a username' },
        { author: { bot: false }, content: 'how do I get the member role?' },
    ]), 'how do I get the member role?');
});

test('extracts a reported username from labels, mentions, and handles', () => {
    assert.equal(extractReportedUsername('username: ToxicKid'), 'ToxicKid');
    assert.equal(extractReportedUsername('IGN is xXProXx'), 'xXProXx');
    assert.equal(extractReportedUsername('reporting Cheater99 for hacks'), 'Cheater99');
    assert.equal(extractReportedUsername('their name is cool_guy'), 'cool_guy');
    assert.equal(extractReportedUsername('report <@111111111111111111>', { ticketOwnerId: '222' }), '<@111111111111111111>');
    assert.equal(extractReportedUsername('report <@111111111111111111>', { ticketOwnerId: '111111111111111111' }), null);
    assert.equal(extractReportedUsername('please help me'), null);
    assert.equal(extractReportedUsername('username: the'), null);
});

test('detects video uploads and clip links, but not screenshots as video', () => {
    assert.equal(isVideoAttachment({ contentType: 'video/mp4', name: 'clip.mp4' }), true);
    assert.equal(isVideoAttachment({ name: 'proof.mov' }), true);
    assert.equal(isImageAttachment({ contentType: 'image/png', name: 'shot.png' }), true);
    assert.equal(isVideoAttachment({ contentType: 'image/png', name: 'shot.png' }), false);

    const links = extractVideoLinks('watch https://medal.tv/games/123 and https://youtu.be/abcd1234');
    assert.ok(links.some((url) => url.includes('medal.tv')));
    assert.ok(links.some((url) => url.includes('youtu.be')));

    const discordImage = extractVideoLinks('https://cdn.discordapp.com/attachments/1/2/shot.png');
    assert.equal(discordImage.length, 0);
});

test('analyzeTicketIntake requires username and video for a complete report', () => {
    const incomplete = analyzeTicketIntake({
        reason: 'I want to report a player for cheating',
        messages: [{
            author: { bot: false, id: 'owner' },
            content: 'username: HackerJoe',
            attachments: [],
        }],
        ticketOwnerId: 'owner',
    });

    assert.equal(incomplete.isPlayerReport, true);
    assert.equal(incomplete.reportedUsername, 'HackerJoe');
    assert.equal(incomplete.hasVideo, false);
    assert.deepEqual(incomplete.missing, ['video']);
    assert.equal(incomplete.complete, false);

    const complete = analyzeTicketIntake({
        reason: 'Player report',
        messages: [{
            author: { bot: false, id: 'owner' },
            content: 'username: HackerJoe https://streamable.com/abcd',
            attachments: [],
        }],
        ticketOwnerId: 'owner',
    });

    assert.equal(complete.complete, true);
    assert.equal(complete.hasVideo, true);
    assert.deepEqual(complete.missing, []);
});

test('once a ticket is a player report it stays a player report', () => {
    const next = analyzeTicketIntake({
        reason: 'hello',
        messages: [{ author: { bot: false }, content: 'just chatting', attachments: [] }],
        previous: { kind: TICKET_KINDS.PLAYER_REPORT },
    });
    assert.equal(next.isPlayerReport, true);
});

test('intake greeting and follow-up ask for missing username and video', () => {
    const analysis = analyzeTicketIntake({ reason: 'report this player please' });
    const greeting = buildIntakeGreeting(analysis);
    assert.match(greeting, /player report/i);
    assert.match(greeting, /username/i);
    assert.match(greeting, /video/i);

    const followUp = buildIntakeFollowUp(analysis);
    assert.match(followUp, /Still needed/i);
    assert.match(followUp, /username/i);
    assert.match(followUp, /video/i);

    const ready = buildIntakeFollowUp({
        isPlayerReport: true,
        complete: true,
        reportedUsername: 'HackerJoe',
        hasVideo: true,
        missing: [],
    });
    assert.match(ready, /HackerJoe/);
    assert.match(ready, /logged this player report/i);
});

test('evidence fingerprint changes when username or video is added', () => {
    const a = evidenceFingerprint({ kind: 'player_report', reportedUsername: null, hasVideo: false, hasImage: false, complete: false });
    const b = evidenceFingerprint({ kind: 'player_report', reportedUsername: 'x', hasVideo: false, hasImage: false, complete: false });
    const c = evidenceFingerprint({ kind: 'player_report', reportedUsername: 'x', hasVideo: true, hasImage: false, complete: true });
    assert.notEqual(a, b);
    assert.notEqual(b, c);
});

test('mergeIntakeState keeps a previously collected username', () => {
    const merged = mergeIntakeState(
        { reportedUsername: 'OldName', kind: TICKET_KINDS.PLAYER_REPORT },
        analyzeTicketIntake({ reason: 'still a player report', previous: { kind: TICKET_KINDS.PLAYER_REPORT, reportedUsername: 'OldName' } }),
    );
    assert.equal(merged.reportedUsername, 'OldName');
    assert.equal(merged.kind, TICKET_KINDS.PLAYER_REPORT);
});

test('describeIntakeForPrompt tells the model what is still missing', () => {
    const missing = describeIntakeForPrompt({
        isPlayerReport: true,
        complete: false,
        missing: ['video'],
        reportedUsername: 'Joe',
        hasVideo: false,
    });
    assert.match(missing, /missing: video/);
    assert.match(missing, /Joe/);
    assert.match(missing, /answer that question first/i);

    const ready = describeIntakeForPrompt({ kind: TICKET_KINDS.PLAYER_REPORT, complete: true, reportedUsername: 'Joe', hasVideo: true });
    assert.match(ready, /complete/i);

    assert.equal(describeIntakeForPrompt({ kind: TICKET_KINDS.GENERAL }), null);
});

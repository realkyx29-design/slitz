import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
process.env.DISCORD_TOKEN = 'test-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

const {
    AI_WARNING_LIMIT,
    CLOSE_TICKET_TOKEN,
    WARN_USER_TOKEN,
    buildAiCloseReason,
    buildKickMessage,
    buildWarningMessage,
    canAiModerateMember,
    countAiWarningsForUser,
    detectClearTrolling,
    evaluateTrollOutcome,
    getAiWarnings,
    parseAiActions,
    resolveModerationTargetId,
    stripActionTokens,
} = await import('../src/services/ticketAI/ticketAiActions.js');

const { sanitizeAiReply } = await import('../src/services/ticketAI/aiSupportService.js');

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

test('parseAiActions detects the close token and strips it from the reply', () => {
    const parsed = parseAiActions(`Glad that worked! Closing this now.\n${CLOSE_TICKET_TOKEN}`);

    assert.equal(parsed.close, true);
    assert.equal(parsed.warn, false);
    assert.equal(parsed.closeReason, null);
    assert.ok(!parsed.text.includes('CLOSE_TICKET'));
    assert.match(parsed.text, /Glad that worked/);
});

test('parseAiActions detects the warn token and captures its reason', () => {
    const parsed = parseAiActions('Please stop spamming. [[WARN_USER: posting nonsense repeatedly]]');

    assert.equal(parsed.warn, true);
    assert.equal(parsed.close, false);
    assert.equal(parsed.warnReason, 'posting nonsense repeatedly');
    assert.ok(!parsed.text.includes('WARN_USER'));
});

test('parseAiActions tolerates loose token formatting from the model', () => {
    for (const variant of ['[CLOSE TICKET]', '[[close-ticket]]', '[[ CLOSE_TICKET ]]']) {
        assert.equal(parseAiActions(`done ${variant}`).close, true, variant);
    }
    for (const variant of ['[WARN USER]', '[[warn-user]]', '[[WARNING_USER: trolling]]']) {
        assert.equal(parseAiActions(`stop ${variant}`).warn, true, variant);
    }
});

test('parseAiActions returns no actions for an ordinary reply', () => {
    const parsed = parseAiActions('You can reset your password from the account settings page.');
    assert.equal(parsed.close, false);
    assert.equal(parsed.warn, false);
});

test('a reply that only mentions closing a ticket in prose does not trigger the action', () => {
    const parsed = parseAiActions('Staff will close the ticket once they have reviewed your report.');
    assert.equal(parsed.close, false);
});

test('stripActionTokens removes every occurrence', () => {
    const stripped = stripActionTokens(`a ${CLOSE_TICKET_TOKEN} b ${WARN_USER_TOKEN} c`);
    assert.ok(!stripped.includes('CLOSE_TICKET'));
    assert.ok(!stripped.includes('WARN_USER'));
});

test('sanitizeAiReply also hides action tokens from users', () => {
    assert.equal(sanitizeAiReply(`All sorted! ${CLOSE_TICKET_TOKEN}`), 'All sorted!');
    assert.equal(sanitizeAiReply(`Last warning. ${WARN_USER_TOKEN}`), 'Last warning.');
});

// ---------------------------------------------------------------------------
// The 3-warning escalation ladder
// ---------------------------------------------------------------------------

test('a user is warned three times before a kick is ever considered', () => {
    const first = evaluateTrollOutcome({ previousWarnings: 0 });
    assert.equal(first.action, 'warn');
    assert.equal(first.warningNumber, 1);
    assert.equal(first.remaining, 2);

    const second = evaluateTrollOutcome({ previousWarnings: 1 });
    assert.equal(second.action, 'warn');
    assert.equal(second.warningNumber, 2);
    assert.equal(second.remaining, 1);

    const third = evaluateTrollOutcome({ previousWarnings: 2 });
    assert.equal(third.action, 'warn');
    assert.equal(third.warningNumber, 3);
    assert.equal(third.remaining, 0);

    const fourth = evaluateTrollOutcome({ previousWarnings: 3 });
    assert.equal(fourth.action, 'kick');
});

test('the kick threshold matches the documented warning limit', () => {
    assert.equal(AI_WARNING_LIMIT, 3);
    for (let previous = 0; previous < AI_WARNING_LIMIT; previous += 1) {
        assert.equal(evaluateTrollOutcome({ previousWarnings: previous }).action, 'warn');
    }
    assert.equal(evaluateTrollOutcome({ previousWarnings: AI_WARNING_LIMIT }).action, 'kick');
});

test('evaluateTrollOutcome copes with corrupt counters and custom limits', () => {
    assert.equal(evaluateTrollOutcome({ previousWarnings: -5 }).warningNumber, 1);
    assert.equal(evaluateTrollOutcome({ previousWarnings: NaN }).warningNumber, 1);
    assert.equal(evaluateTrollOutcome({ previousWarnings: 0, limit: 0 }).limit, AI_WARNING_LIMIT);
    assert.equal(evaluateTrollOutcome({ previousWarnings: 4, limit: 5 }).action, 'warn');
    assert.equal(evaluateTrollOutcome({ previousWarnings: 5, limit: 5 }).action, 'kick');
});

// ---------------------------------------------------------------------------
// Warning bookkeeping
// ---------------------------------------------------------------------------

test('getAiWarnings normalizes missing or malformed history', () => {
    assert.deepEqual(getAiWarnings(null), []);
    assert.deepEqual(getAiWarnings({}), []);
    assert.deepEqual(getAiWarnings({ aiWarnings: 'nope' }), []);
    assert.deepEqual(getAiWarnings({ aiWarnings: [null, 'x'] }), []);
});

test('warnings are counted per user, not per ticket', () => {
    const ticket = {
        aiWarnings: [
            { userId: 'a' },
            { userId: 'b' },
            { userId: 'a' },
        ],
    };
    assert.equal(countAiWarningsForUser(ticket, 'a'), 2);
    assert.equal(countAiWarningsForUser(ticket, 'b'), 1);
    assert.equal(countAiWarningsForUser(ticket, 'c'), 0);
    assert.equal(countAiWarningsForUser(ticket, null), 0);
});

test('clear trolling detection catches deliberate admissions and repeated spam', () => {
    assert.deepEqual(detectClearTrolling({
        ownerId: 'owner',
        messages: [{ author: { id: 'owner', bot: false }, content: "I'm just trolling" }],
    }), { warn: true, reason: 'deliberate trolling or wasting support time' });

    assert.deepEqual(detectClearTrolling({
        ownerId: 'owner',
        messages: [
            { author: { id: 'owner', bot: false }, content: 'spam me' },
            { author: { id: 'owner', bot: false }, content: 'spam me' },
            { author: { id: 'owner', bot: false }, content: 'spam me' },
        ],
    }), { warn: true, reason: 'repeated spam messages' });

    assert.deepEqual(detectClearTrolling({
        ownerId: 'owner',
        messages: [
            { author: { id: 'owner', bot: false }, content: 'shut up bot' },
            { author: { id: 'owner', bot: false }, content: 'you are an idiot' },
            { author: { id: 'owner', bot: false }, content: 'fuck this ticket' },
        ],
    }), { warn: true, reason: 'repeated abusive messages' });
});

test('clear trolling detection does not warn on one rude or frustrated message', () => {
    const result = detectClearTrolling({
        ownerId: 'owner',
        messages: [{ author: { id: 'owner', bot: false }, content: 'This is frustrating, please help me!' }],
    });
    assert.deepEqual(result, { warn: false, reason: null });
});

// ---------------------------------------------------------------------------
// Targeting & guard rails
// ---------------------------------------------------------------------------

test('only the ticket creator can be targeted, and only when they spoke last', () => {
    const ticket = { userId: 'owner' };
    assert.equal(resolveModerationTargetId(ticket, { lastAuthorId: 'owner' }), 'owner');
    assert.equal(resolveModerationTargetId(ticket, { lastAuthorId: 'someone-else' }), null);
    assert.equal(resolveModerationTargetId(ticket, {}), 'owner');
    assert.equal(resolveModerationTargetId({}, { lastAuthorId: 'owner' }), null);
});

function makeMember(overrides = {}) {
    return {
        id: 'user-1',
        user: { bot: false },
        guild: { ownerId: 'guild-owner' },
        roles: { cache: new Map() },
        permissions: { has: () => false },
        kickable: true,
        ...overrides,
    };
}

test('the AI refuses to moderate staff, admins, bots, the owner, or itself', () => {
    assert.equal(canAiModerateMember(null).ok, false);
    assert.equal(canAiModerateMember(makeMember({ user: { bot: true } })).reason, 'target-is-bot');
    assert.equal(
        canAiModerateMember(makeMember({ id: 'bot-1' }), { botMemberId: 'bot-1' }).reason,
        'target-is-self',
    );
    assert.equal(
        canAiModerateMember(makeMember({ id: 'guild-owner' })).reason,
        'target-is-owner',
    );
    assert.equal(
        canAiModerateMember(makeMember({ permissions: { has: (p) => p === 'Administrator' } })).reason,
        'target-is-staff',
    );
    assert.equal(
        canAiModerateMember(makeMember({ permissions: { has: (p) => p === 'KickMembers' } })).reason,
        'target-is-staff',
    );
    assert.equal(
        canAiModerateMember(makeMember({ roles: { cache: new Map([['staff-role', true]]) } }), { staffRoleId: 'staff-role' }).reason,
        'target-is-staff',
    );
    assert.equal(canAiModerateMember(makeMember({ kickable: false })).reason, 'not-kickable');
});

test('an ordinary member can be moderated', () => {
    assert.deepEqual(canAiModerateMember(makeMember(), { staffRoleId: 'staff-role' }), { ok: true, reason: null });
});

// ---------------------------------------------------------------------------
// User-facing copy
// ---------------------------------------------------------------------------

test('warning messages count down to the kick', () => {
    assert.match(buildWarningMessage({ warningNumber: 1 }), /Warning 1\/3/);
    assert.match(buildWarningMessage({ warningNumber: 1 }), /\*\*2\*\* warnings left/);
    assert.match(buildWarningMessage({ warningNumber: 2 }), /\*\*1\*\* warning left/);
    assert.match(buildWarningMessage({ warningNumber: 3 }), /final warning/i);
});

test('warning messages include the reason when the model gave one', () => {
    const message = buildWarningMessage({ warningNumber: 1, reason: 'spamming emojis' });
    assert.match(message, /spamming emojis/);
});

test('the kick notice states how many warnings were given', () => {
    assert.match(buildKickMessage({}), /3\*\* warnings/);
});

test('AI close reasons are labelled and clamped', () => {
    assert.equal(buildAiCloseReason('resolved by docs link'), 'AI assistant: resolved by docs link');
    assert.equal(buildAiCloseReason(''), 'AI assistant: issue resolved');
    assert.equal(buildAiCloseReason(null), 'AI assistant: issue resolved');
    assert.ok(buildAiCloseReason('x'.repeat(1000)).length < 350);
});

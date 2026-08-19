/**
 * Backfill parsers, tested against REAL messages captured from the TWO server
 * on 2026-08-19. No network, no token.
 *
 * Every sample below is a verbatim embed from a live log channel, with only
 * the long role lists trimmed. That matters: log formats are decided by
 * third-party bots and change without warning, and the failure mode is silent
 * - the backfill reports zero and looks like an empty server rather than a
 * broken parser. If one of these tests fails, the format moved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateToSnowflake,
  memberLogKindForChannel,
  parseLeaveAttribution,
  parseMemberLogMessage,
  parseVoiceMessage,
  snowflakeToDate,
} from '../src/backfill/parse.ts';
import type { RawMessage } from '../src/discord/rest.ts';

const at = '2026-08-19T19:32:15.762000+00:00';

const msg = (embed: Record<string, unknown>, timestamp = at): RawMessage => ({
  id: '1',
  timestamp,
  embeds: [embed as never],
});

// --- #join-leave-log: titled embeds (the current Logger + Invite Tracker) ---

test('titled "Member joined" is a join', () => {
  const r = parseMemberLogMessage(
    msg({
      title: 'Member joined',
      description: '<@1539711683898118154> 107th to join\n⚠️ **NEW ACCOUNT** created 27 minutes and 40 seconds ago⚠️',
      footer: { text: 'ID: 1539711683898118154' },
    }),
  );
  assert.deepEqual(r, { memberId: '1539711683898118154', kind: 'join', occurredAt: at });
});

test('titled "Member left" is a leave, and the roles list does not confuse the id', () => {
  // The description mentions several ROLE snowflakes (<@&...>) before anything
  // else. Keying on the footer rather than the first number in the text is the
  // whole reason this parses correctly.
  const r = parseMemberLogMessage(
    msg({
      title: 'Member left',
      description:
        '<@720351927581278219> joined 3 years, 5 months and 11 days ago\n' +
        '**Roles:** <@&1060912046012633148> <@&1101170473108242452> <@&1101297337919340585>',
      footer: { text: 'ID: 720351927581278219' },
    }),
  );
  assert.equal(r?.kind, 'leave');
  assert.equal(r?.memberId, '720351927581278219');
});

test('a titled embed we do not recognise is not a join', () => {
  // #member-log is full of these. Counting them would inflate joins wildly.
  assert.equal(
    parseMemberLogMessage(
      msg({
        title: 'Role added',
        description: '<@&1144789677057003636>',
        footer: { text: 'ID: 1539711683898118154' },
      }),
    ),
    null,
  );
});

// --- #member-join / #member-leave: titleless, channel carries the meaning ---

test('titleless embed is unreadable without the channel, and correct with it', () => {
  const m = msg({
    description: '<@1329713790065049701> danielarellano0911',
    footer: { text: 'ID: 1329713790065049701' },
  });
  assert.equal(parseMemberLogMessage(m), null, 'no channel context = no guess');
  assert.deepEqual(parseMemberLogMessage(m, 'join'), {
    memberId: '1329713790065049701',
    kind: 'join',
    occurredAt: at,
  });
});

test('the nickname form of a mention (<@!id>) still resolves', () => {
  const r = parseMemberLogMessage(
    msg({
      description: '<@!1298143954834817030> jefferyrichard9703',
      footer: { text: 'ID: 1298143954834817030' },
    }),
    'leave',
  );
  assert.equal(r?.memberId, '1298143954834817030');
  assert.equal(r?.kind, 'leave');
});

test('a titled embed is never overridden by the channel it sits in', () => {
  // Guards the fallback: #member-join also carries the occasional titled
  // embed, and the title is the more specific signal.
  const r = parseMemberLogMessage(
    msg({ title: 'Role added', description: 'x', footer: { text: 'ID: 123456789012345678' } }),
    'join',
  );
  assert.equal(r, null);
});

test('channel names map to the event they are dedicated to', () => {
  assert.equal(memberLogKindForChannel('member-join'), 'join');
  assert.equal(memberLogKindForChannel('member-leave'), 'leave');
  assert.equal(memberLogKindForChannel('member-ban'), 'leave');
  assert.equal(memberLogKindForChannel('member-unban'), null, 'an unban is not a departure');
  assert.equal(memberLogKindForChannel('member-role-add'), null);
  assert.equal(memberLogKindForChannel('join-leave-log'), null, 'mixed feed: read the titles');
  assert.equal(memberLogKindForChannel(undefined), null);
});

// --- voice: two bots, two formats -------------------------------------------

test('Logger voice format (titled)', () => {
  const r = parseVoiceMessage(
    msg({
      title: 'Member left voice channel',
      description: '**ghostly.og** left #💤 AFK',
      footer: { text: 'ID: 83104159292723200' },
    }),
  );
  assert.equal(r?.kind, 'leave');
  assert.equal(r?.memberId, '83104159292723200');
  // This logger writes the channel NAME, not a <#id> mention, so there is no
  // channel id to recover. Recording the session still works; attributing it
  // to a room does not.
  assert.equal(r?.channelId, null);
});

test('Logger "changed voice channel" counts as presence', () => {
  const r = parseVoiceMessage(
    msg({
      title: 'Member changed voice channel',
      description: '**Before:** #🔞〢The Bar\n**+After:** #💤 AFK',
      footer: { text: 'ID: 83104159292723200' },
    }),
  );
  assert.equal(r?.kind, 'change');
});

test('Wick voice format (titleless, mention-based) keeps the channel id', () => {
  const r = parseVoiceMessage(
    msg({
      description: '**<@452890077333553154> joined voice channel <#1175127344072118405>**',
      footer: { text: 'ID: 452890077333553154' },
    }),
  );
  assert.deepEqual(r, {
    memberId: '452890077333553154',
    channelId: '1175127344072118405',
    kind: 'join',
    occurredAt: at,
  });
});

test('a non-voice embed is not a voice session', () => {
  assert.equal(parseVoiceMessage(msg({ title: 'Member joined', description: '<@1> hi' })), null);
  assert.equal(parseVoiceMessage({ id: '1', timestamp: at }), null);
});

// --- #invites: real, but deliberately unusable for the funnel ---------------

test('the invite-tracker leave line parses, and proves why it cannot be used', () => {
  const r = parseLeaveAttribution({
    id: '1',
    timestamp: at,
    content: 'Streamcord#2800 left the server. I can not figure out how they joined.',
  });
  assert.equal(r?.username, 'Streamcord#2800');
  assert.equal(r?.joinedVia, 'unknown');
  // No snowflake anywhere in the line. This is the record we have of historic
  // attribution, and it cannot be joined to a member - which is exactly why
  // live invite tracking (TWO-11) is still worth deploying.
  assert.equal('memberId' in (r as object), false);
});

// --- snowflake time bounds ---------------------------------------------------

test('snowflake <-> date round-trips to the second', () => {
  const d = new Date('2024-03-01T12:00:00.000Z');
  const back = snowflakeToDate(dateToSnowflake(d));
  assert.ok(Math.abs(back.getTime() - d.getTime()) < 1000);
});

test('a real snowflake decodes to a plausible creation time', () => {
  // The bot's own account, created 2026-08-19.
  const d = snowflakeToDate('1539711683898118154');
  assert.equal(d.toISOString().slice(0, 4), '2026');
});

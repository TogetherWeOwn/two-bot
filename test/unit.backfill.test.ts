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
import { findEarlyMessages } from '../src/backfill/messages.ts';
import type { DiscordRest, RawMessage } from '../src/discord/rest.ts';

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

// --- the message ladder scan (TWO-95) ---------------------------------------

/**
 * A Discord REST stand-in. `scanChannel` pages newest-first and stops on a
 * short batch, so one page per channel in descending time is a complete scan.
 */
function fakeRest(pages: Record<string, RawMessage[]>): DiscordRest {
  const get = async (path: string): Promise<unknown> => {
    if (path === '/guilds/g/channels') {
      return Object.keys(pages).map((id) => ({ id, type: 0, name: `chan-${id}` }));
    }
    if (path.startsWith('/guilds/g/threads/active')) return { threads: [] };
    const id = path.match(/^\/channels\/([^/]+)\/messages/)?.[1] ?? '';
    // Newest first, which is the order Discord returns.
    return [...(pages[id] ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  };
  return { get, requests: 0 } as unknown as DiscordRest;
}

const post = (id: string, authorId: string, timestamp: string, bot = false): RawMessage => ({
  id,
  timestamp,
  author: { id: authorId, bot },
});

test('the scan keeps a member\'s earliest three posts, across channels and out of order', async () => {
  const { early } = await findEarlyMessages(
    fakeRest({
      // Deliberately interleaved: the earliest three are split across both
      // channels, and neither channel alone holds them in order.
      c1: [
        post('5', 'alice', '2026-03-05T00:00:00.000Z'),
        post('1', 'alice', '2026-03-01T00:00:00.000Z'),
        post('4', 'alice', '2026-03-04T00:00:00.000Z'),
      ],
      c2: [
        post('3', 'alice', '2026-03-03T00:00:00.000Z'),
        post('2', 'alice', '2026-03-02T00:00:00.000Z'),
      ],
    }),
    { guildId: 'g', maxPagesPerChannel: 10 },
  );
  assert.deepEqual(
    early.get('alice')?.rungs.map((r) => r.at),
    ['2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z', '2026-03-03T00:00:00.000Z'],
  );
});

test('two posts is two rungs - no third message is invented', async () => {
  const { early, summary } = await findEarlyMessages(
    fakeRest({
      c1: [
        post('1', 'bob', '2026-03-01T00:00:00.000Z'),
        post('2', 'bob', '2026-03-02T00:00:00.000Z'),
      ],
    }),
    { guildId: 'g', maxPagesPerChannel: 10 },
  );
  assert.equal(early.get('bob')?.rungs.length, 2);
  assert.equal(summary.authorsSeen, 1);
  // The number the report leans on: nobody here clears the AM7 text bar.
  assert.equal(summary.authorsWithFullLadder, 0);
});

test('one message seen twice is one rung, not two', async () => {
  // The same post reachable through two targets (a forum post is both a thread
  // and a channel to this API). Counting it twice would fabricate a ladder.
  const dupe = post('1', 'carol', '2026-03-01T00:00:00.000Z');
  const { early } = await findEarlyMessages(
    fakeRest({ c1: [dupe], c2: [dupe, post('2', 'carol', '2026-03-02T00:00:00.000Z')] }),
    { guildId: 'g', maxPagesPerChannel: 10 },
  );
  assert.deepEqual(
    early.get('carol')?.rungs.map((r) => r.id),
    ['1', '2'],
  );
});

test('bot posts never reach the ladder', async () => {
  const { early } = await findEarlyMessages(
    fakeRest({
      c1: [
        post('1', 'botly', '2026-03-01T00:00:00.000Z', true),
        post('2', 'botly', '2026-03-02T00:00:00.000Z', true),
        post('3', 'botly', '2026-03-03T00:00:00.000Z', true),
      ],
    }),
    { guildId: 'g', maxPagesPerChannel: 10 },
  );
  assert.equal(early.size, 0);
});

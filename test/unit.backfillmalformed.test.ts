/**
 * Malformed-input suite for src/backfill/parse.ts (TOG-8670).
 *
 * parse.ts reads untrusted export JSON: truncated rows, logger format drift,
 * hand-edited fixtures. Every export is total over that input - a bad row
 * parses as null (or a safe bound for the snowflake helpers), never throws,
 * and a returned record always carries a parseable `occurredAt`, so the
 * backfill script's `new Date(occurredAt).toISOString()` cannot throw
 * mid-scan and abort the run with a partial write behind it.
 *
 * No network, no token, no live guild. Fixtures only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelIdFromEmbed,
  dateToSnowflake,
  memberIdFromEmbed,
  memberLogKindForChannel,
  parseLeaveAttribution,
  parseMemberLogMessage,
  parseVoiceMessage,
  snowflakeToDate,
} from '../src/backfill/parse.ts';

const at = '2026-08-19T19:32:15.762000+00:00';
const MID = '1539711683898118154';

const voiceEmbed = () => ({
  title: 'Member joined voice channel',
  description: '**ghostly.og** joined #general',
  footer: { text: `ID: ${MID}` },
});

const memberEmbed = () => ({
  title: 'Member joined',
  description: `<@${MID}> 107th to join`,
  footer: { text: `ID: ${MID}` },
});

// --- garbage message shapes: null, never throw -------------------------------

test('parseVoiceMessage refuses garbage message shapes without throwing', () => {
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { id: '1' },
    { id: '1', timestamp: 'not-a-date' },
    { id: '1', timestamp: 123 },
    { id: '1', timestamp: at },
    { id: '1', timestamp: at, embeds: 'oops' },
    { id: '1', timestamp: at, embeds: {} },
    { id: '1', timestamp: at, embeds: [null] },
    { id: '1', timestamp: at, embeds: ['hi'] },
    { id: '1', timestamp: at, embeds: [42] },
    { id: '1', timestamp: at, embeds: [] },
    null,
  ];
  for (const g of garbage) {
    assert.equal(parseVoiceMessage(g), null, `voice refused: ${JSON.stringify(g)?.slice(0, 80)}`);
  }
});

test('parseMemberLogMessage refuses garbage message shapes without throwing', () => {
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { id: '1', timestamp: at },
    { id: '1', timestamp: at, embeds: [null] },
    { id: '1', timestamp: 'garbage', embeds: [memberEmbed()] },
  ];
  for (const g of garbage) {
    assert.equal(parseMemberLogMessage(g), null, `member refused: ${JSON.stringify(g)?.slice(0, 80)}`);
    assert.equal(
      parseMemberLogMessage(g, 'join'),
      null,
      `member refused even with channel hint: ${JSON.stringify(g)?.slice(0, 80)}`,
    );
  }
});

test('parseLeaveAttribution refuses garbage message shapes without throwing', () => {
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { id: '1', timestamp: at },
    { id: '1', timestamp: at, content: 123 },
    { id: '1', timestamp: at, content: null },
    { id: '1', timestamp: at, content: ['left the server. x'] },
    { id: '1', timestamp: 'not-a-date', content: 'x left the server. vanity' },
  ];
  for (const g of garbage) {
    assert.equal(parseLeaveAttribution(g), null, `leave refused: ${JSON.stringify(g)?.slice(0, 80)}`);
  }
});

// --- truncated / drifted embeds ------------------------------------------------

test('voice embed with non-string fields is refused, not coerced', () => {
  // A drifted logger sending numbers/arrays where text used to be.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{ title: 42, description: ['joined voice channel'], footer: { text: `ID: ${MID}` } }],
    }),
    null,
  );
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{ title: 'Member joined voice channel', description: null, footer: null }],
    }),
    null,
    'no member id anywhere = no record',
  );
});

test('member embed with a non-string title ignores the channel hint', () => {
  // A present-but-wrong-typed title is a titled embed we do not recognise,
  // so the titleless-channel fallback must not mint a join from it.
  assert.equal(
    parseMemberLogMessage(
      { id: '1', timestamp: at, embeds: [{ title: 7, footer: { text: `ID: ${MID}` } }] },
      'join',
    ),
    null,
  );
});

test('truncated footer and mention variants resolve or refuse cleanly', () => {
  // Footer cut mid-id: too short to be a snowflake, and no mention either.
  assert.equal(memberIdFromEmbed({ footer: { text: 'ID: 15397' } }), null);
  // A 26-digit run is not a snowflake: refuse rather than key on a prefix.
  assert.equal(memberIdFromEmbed({ footer: { text: `ID: ${MID}1234567` } }), null);
  // Mention fallback still works when the footer carries no id.
  assert.equal(
    memberIdFromEmbed({ description: '<@!1298143954834817030> name', footer: { text: 'n/a' } }),
    '1298143954834817030',
  );
  // Garbage embed shapes.
  for (const g of [null, undefined, 42, 'x', [], { footer: 7 }, { description: {} }]) {
    assert.equal(memberIdFromEmbed(g), null);
    assert.equal(channelIdFromEmbed(g), null);
  }
});

test('adversarial footers cannot inject a member id', () => {
  // "ID:" with no digits, negative lookahead bait, and embedded newlines.
  assert.equal(memberIdFromEmbed({ footer: { text: 'ID: ' } }), null);
  // Letters between the colon and the digits: no parseable id, refuse.
  assert.equal(memberIdFromEmbed({ footer: { text: `ID: abc${MID}` } }), null);
  assert.equal(
    memberIdFromEmbed({ footer: { text: `ID:\n${MID}` } }),
    MID,
    'whitespace after the colon still matches',
  );
});

// --- invite-tracker lines ------------------------------------------------------

test('leave line without a username is a truncated row, not churn', () => {
  assert.equal(parseLeaveAttribution({ id: '1', timestamp: at, content: ' left the server. vanity' }), null);
  assert.equal(parseLeaveAttribution({ id: '1', timestamp: at, content: 'left the server.' }), null);
});

test('leave line still classifies vanity and oauth', () => {
  assert.equal(
    parseLeaveAttribution({ id: '1', timestamp: at, content: 'SomeUser#1234 left the server. Joined via vanity.' })
      ?.joinedVia,
    'vanity',
  );
  assert.equal(
    parseLeaveAttribution({ id: '1', timestamp: at, content: 'SomeUser#1234 left the server. Joined via oauth invite.' })
      ?.joinedVia,
    'oauth',
  );
});

// --- channel names -------------------------------------------------------------

test('memberLogKindForChannel refuses non-string names without throwing', () => {
  for (const g of [null, undefined, 123, {}, [], true]) {
    assert.equal(memberLogKindForChannel(g), null);
  }
  assert.equal(memberLogKindForChannel('member-join'), 'join');
});

test('parseMemberLogMessage ignores a drifted channel hint', () => {
  const m = { id: '1', timestamp: at, embeds: [memberEmbed()] };
  delete (m.embeds[0] as Record<string, unknown>).title;
  assert.equal(parseMemberLogMessage(m, 'ban' as never), null, 'only join/leave are trusted');
  assert.deepEqual(parseMemberLogMessage(m, 'join'), { memberId: MID, kind: 'join', occurredAt: at });
});

// --- snowflake bounds ----------------------------------------------------------

test('snowflakeToDate refuses corrupt ids without throwing', () => {
  const epoch = new Date('2015-01-01T00:00:00.000Z').getTime();
  for (const g of ['abc', '', '  ', '-1', '12.5', '0x123', null, undefined, 42, {}, []]) {
    assert.equal(snowflakeToDate(g).getTime(), epoch, `id refused: ${JSON.stringify(g)}`);
  }
  // Out-of-range numerics saturate at the epoch instead of yielding Invalid Date.
  assert.equal(snowflakeToDate('9'.repeat(100)).getTime(), epoch);
});

test('dateToSnowflake refuses bad dates without throwing', () => {
  for (const g of [new Date(NaN), 'x', 123, null, undefined, {}]) {
    assert.equal(dateToSnowflake(g), '0', `date refused: ${String(g)?.slice(0, 40)}`);
  }
});

test('valid snowflake conversions are unchanged', () => {
  const d = new Date('2024-03-01T12:00:00.000Z');
  const back = snowflakeToDate(dateToSnowflake(d));
  assert.ok(Math.abs(back.getTime() - d.getTime()) < 1000);
  assert.equal(snowflakeToDate(MID).toISOString().slice(0, 4), '2026');
});

// --- TOG-9989 regressions: probe-found bugs ------------------------------------

test('titled voice with no footer id ignores a stray description mention (TOG-10025)', () => {
  // Logger titled descriptions carry the display name, never a member mention.
  // A mention in the text with an id-less footer is incidental (a thank-you, a
  // quoted reply) - minting attribution from it fabricates a voice session.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{
        title: 'Member joined voice channel',
        description: '**ghostly.og** joined #general, thanks <@1298143954834817030>!',
        footer: { text: 'ID: n/a' },
      }],
    }),
    null,
  );
  // The footer-id path is untouched: titled rows with a real footer still parse.
  assert.equal(
    parseVoiceMessage({ id: '1', timestamp: at, embeds: [voiceEmbed()] })?.memberId,
    MID,
  );
  // Wick titleless embeds keep the footer-then-mention fallback.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{
        description: `**<@${MID}> joined voice channel <#1175127344072118405>**`,
        footer: { text: 'n/a' },
      }],
    })?.memberId,
    MID,
  );
});

test('placeholder usernames are truncated rows, not churn (TOG-10026)', () => {
  for (const name of ['TODO', 'todo', 'TBD', 'FIXME', 'xxx', '???', '?', 'Placeholder', 'UNKNOWN', 'Unknown User']) {
    assert.equal(
      parseLeaveAttribution({ id: '1', timestamp: at, content: `${name} left the server. vanity` }),
      null,
      `placeholder refused: ${name}`,
    );
  }
  // Real usernames still parse, including ones merely CONTAINING a keyword.
  assert.equal(
    parseLeaveAttribution({ id: '1', timestamp: at, content: 'TodoFan99 left the server. vanity' })?.username,
    'TodoFan99',
  );
  assert.equal(
    parseLeaveAttribution({ id: '1', timestamp: at, content: 'X#1 left the server. vanity' })?.username,
    'X#1',
  );
});

test('padded member titles still parse, whitespace-only titles still guess nothing (TOG-10027)', () => {
  const padded = (title: string) => ({
    id: '1',
    timestamp: at,
    embeds: [{ title, description: `<@${MID}> hi`, footer: { text: `ID: ${MID}` } }],
  });
  assert.equal(parseMemberLogMessage(padded('Member joined '))?.kind, 'join');
  assert.equal(parseMemberLogMessage(padded('  Member left  '))?.kind, 'leave');
  // A whitespace-only title is a titled embed we do not recognise: the channel
  // hint must not mint a join from it.
  assert.equal(parseMemberLogMessage(padded('   '), 'join'), null);
});

// --- TOG-9989 extensions: garbage, truncated, TODO markers -----------------------

test('TODO-marker rows parse as null across every parser', () => {
  assert.equal(memberIdFromEmbed({ footer: { text: 'ID: TODO' } }), null);
  assert.equal(
    parseVoiceMessage({ id: '1', timestamp: at, embeds: [{ title: 'TODO', description: 'TODO', footer: { text: 'TODO' } }] }),
    null,
  );
  assert.equal(
    parseVoiceMessage({ id: '1', timestamp: 'TODO', embeds: [voiceEmbed()] }),
    null,
    'TODO timestamp is a truncated row',
  );
  // A drifted TODO channel hint on a titleless embed mints nothing (and a
  // titled embed ignores any hint - title wins, covered in unit.backfill).
  const titleless = { id: '1', timestamp: at, embeds: [{ description: `<@${MID}> x`, footer: { text: `ID: ${MID}` } }] };
  assert.equal(
    parseMemberLogMessage(titleless, 'TODO' as never),
    null,
    'TODO channel hint mints nothing',
  );
});

test('truncated logger rows refuse instead of half-parsing', () => {
  // Timestamp with trailing garbage: corrupt export row, not a date.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: `${at}xyz`,
      embeds: [voiceEmbed()],
    }),
    null,
  );
  // Numeric timestamps never appear in export JSON (strings only).
  assert.equal(
    parseVoiceMessage({ id: '1', timestamp: 1784988735762, embeds: [voiceEmbed()] }),
    null,
  );
  // Mid-phrase truncation of a Wick description: no complete kind phrase.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{ description: `**<@${MID}> joined voice cha`, footer: { text: `ID: ${MID}` } }],
    }),
    null,
  );
  // A footer truncated below snowflake width with no mention: no record.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{ title: 'Member joined voice channel', description: 'x', footer: { text: 'ID: 15397' } }],
    }),
    null,
  );
  // Boundary: exactly 15 digits still counts as a snowflake.
  assert.equal(memberIdFromEmbed({ footer: { text: 'ID: 123456789012345' } }), '123456789012345');
});

test('channel-name mapping refuses near-miss suffixes', () => {
  assert.equal(memberLogKindForChannel('member-join-log'), 'join', 'hyphen boundary is a separator');
  assert.equal(memberLogKindForChannel('member-join2'), 'join', 'digit boundary is a separator');
  assert.equal(memberLogKindForChannel('member-joinx'), null, 'letter suffix is a different channel');
  assert.equal(memberLogKindForChannel('premember-join'), null, 'letter prefix is a different channel');
  assert.equal(memberLogKindForChannel('MEMBER-JOIN'), 'join', 'case-insensitive');
});

test('title-case and wick move variants keep their kinds', () => {
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{ title: 'MEMBER JOINED VOICE CHANNEL', description: 'x', footer: { text: `ID: ${MID}` } }],
    })?.kind,
    'join',
  );
  // Wick historic "moved" phrasing is a channel change, not a fresh join.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{
        description: `**<@${MID}> moved voice channel <#1175127344072118405>**`,
        footer: { text: `ID: ${MID}` },
      }],
    })?.kind,
    'change',
  );
  // An explicitly empty title is titleless: description mention still resolves.
  assert.equal(
    parseVoiceMessage({
      id: '1',
      timestamp: at,
      embeds: [{
        title: '',
        description: `**<@${MID}> joined voice channel <#1175127344072118405>**`,
        footer: { text: 'n/a' },
      }],
    })?.memberId,
    MID,
  );
});

test('multiline leave content still attributes', () => {
  // Export JSON may carry a literal newline inside the username slot from a
  // copy-paste; the match spans it and the tail still classifies.
  const r = parseLeaveAttribution({ id: '1', timestamp: at, content: 'SomeUser\nleft the server. vanity' });
  assert.equal(r?.username, 'SomeUser');
  assert.equal(r?.joinedVia, 'vanity');
});

// --- no-throw, no-partial-write sweep -------------------------------------------

test('every parser returns records with write-safe timestamps', () => {
  const voice = parseVoiceMessage({ id: '1', timestamp: at, embeds: [voiceEmbed()] });
  const member = parseMemberLogMessage({ id: '1', timestamp: at, embeds: [memberEmbed()] });
  const leave = parseLeaveAttribution({ id: '1', timestamp: at, content: 'X#1 left the server. vanity' });
  for (const r of [voice, member, leave]) {
    assert.ok(r, 'valid fixture still parses');
    // This is the exact call scripts/backfill.ts makes per record: it must
    // not throw, or the scan aborts mid-write.
    assert.doesNotThrow(() => new Date(r!.occurredAt).toISOString());
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRotaNotice, hasRotaNoticeIdentity, rotaNoticeEntryId } from '../src/discord/rotaNoticePayload.ts';
import type { RotaNoticeCandidate } from '../src/analytics/onboardingRota.ts';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ACTION = '333333333333333333';
const MEMBER = 'a'.repeat(64);

function candidate(overrides: Partial<RotaNoticeCandidate> = {}): RotaNoticeCandidate {
  return {
    memberId: MEMBER, actionId: ACTION, channelId: CHANNEL,
    sourceCohort: 'invite:campaign', actionAt: '2026-09-01T23:05:00.000Z',
    dueAt: '2026-09-01T23:35:00.000Z', elapsedSeconds: 1800,
    coverageBlock: 'America/Chicago 18:00–22:00 daily', ...overrides,
  };
}

test('payload is deterministic, labeled, and carries the recovery identity', () => {
  const first = formatRotaNotice(candidate(), { guildId: GUILD, destinationChannelId: CHANNEL });
  const second = formatRotaNotice(candidate({ elapsedSeconds: 1805 }), { guildId: GUILD, destinationChannelId: CHANNEL });
  assert.equal(first.entryId, `rota-notice:${GUILD}:${MEMBER}:${ACTION}`);
  assert.equal(first.entryId, rotaNoticeEntryId(GUILD, MEMBER, ACTION));
  assert.equal(second.entryId, first.entryId, 'elapsed drift does not fork identity');
  assert.ok(hasRotaNoticeIdentity(first.content, first.entryId));
  assert.match(first.content, /rota fallback notice.*\(bot\)/);
  assert.match(first.content, new RegExp(`https://discord\\.com/channels/${GUILD}/${CHANNEL}/${ACTION}`));
  assert.match(first.content, /30 min without a human reply/);
  assert.match(first.content, new RegExp(`from <#${CHANNEL}>`));
  assert.match(first.content, /America\/Chicago 18:00–22:00 daily/);
  assert.deepEqual(first.allowedMentions, { parse: [] });
  assert.ok(first.content.length <= 2000);
});

test('payload contains no handle, raw id, cohort, or message body', () => {
  const { content } = formatRotaNotice(
    candidate({ sourceCohort: 'invite:secret-campaign' }),
    { guildId: GUILD, destinationChannelId: CHANNEL },
  );
  assert.doesNotMatch(content, /secret-campaign/);
  assert.doesNotMatch(content, /@[a-z]/i);
  assert.ok(!content.includes(GUILD) || content.includes(`channels/${GUILD}/`),
    'guild id appears only inside the action link');
});

test('member-supplied text cannot reshape the notice', () => {
  const evil = candidate({
    memberId: 'b'.repeat(64), actionId: ACTION, channelId: CHANNEL,
    coverageBlock: 'x\n@everyone ping',
  });
  const content = formatRotaNotice(evil, { guildId: GUILD, destinationChannelId: CHANNEL }).content;
  assert.ok(content.includes('`x\n@everyone ping`'), 'coverage label is quoted, not parsed');
});

test('invalid snowflakes, pseudonyms, and clocks are refused', () => {
  const base = candidate();
  assert.throws(() => formatRotaNotice({ ...base, memberId: 'not-a-pseudonym' },
    { guildId: GUILD, destinationChannelId: CHANNEL }));
  assert.throws(() => formatRotaNotice({ ...base, actionId: 'short' },
    { guildId: GUILD, destinationChannelId: CHANNEL }));
  assert.throws(() => formatRotaNotice(base, { guildId: 'live', destinationChannelId: CHANNEL }));
  assert.throws(() => formatRotaNotice(base, { guildId: GUILD, destinationChannelId: 'nope' }));
  assert.throws(() => formatRotaNotice({ ...base, elapsedSeconds: NaN },
    { guildId: GUILD, destinationChannelId: CHANNEL }));
  assert.throws(() => formatRotaNotice({ ...base, elapsedSeconds: -1 },
    { guildId: GUILD, destinationChannelId: CHANNEL }));
});

test('payload refuses content exceeding the Discord length', () => {
  const base = candidate();
  assert.throws(() => formatRotaNotice({ ...base, coverageBlock: 'x'.repeat(2000) },
    { guildId: GUILD, destinationChannelId: CHANNEL }), /exceeds Discord content length/);
});

test('recovery identity pins the exact entry; other entries do not match', () => {
  const { entryId } = formatRotaNotice(candidate(), { guildId: GUILD, destinationChannelId: CHANNEL });
  const content = formatRotaNotice(candidate(), { guildId: GUILD, destinationChannelId: CHANNEL }).content;
  assert.equal(hasRotaNoticeIdentity(content, entryId), true);
  assert.equal(hasRotaNoticeIdentity(content, `${entryId}-other`), false);
  assert.equal(hasRotaNoticeIdentity('unrelated message', entryId), false);
});

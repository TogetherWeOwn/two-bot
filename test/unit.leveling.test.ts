import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/testDb.ts';
import {
  LevelingService,
  MAX_STORED_XP,
  levelForXp,
  totalXpForLevel,
} from '../src/leveling/service.ts';
import { rankText } from '../src/leveling/discord.ts';

const fixture = await openTestDb(import.meta.filename);
after(() => fixture.cleanup());
beforeEach(() => fixture.reset());

const GUILD = '1545644954272137297';
const A = '100000000000000001';
const B = '100000000000000002';

function at(seconds: number): string {
  return new Date(Date.parse('2026-09-08T12:00:00Z') + seconds * 1000).toISOString();
}

test('MEE6 curve round-trips level thresholds', () => {
  for (let level = 0; level <= 100; level++) {
    const threshold = totalXpForLevel(level);
    assert.equal(levelForXp(threshold), level);
    if (level > 0) assert.equal(levelForXp(threshold - 1), level - 1);
  }
});

test('message XP enforces a durable one-minute cooldown', async () => {
  const service = new LevelingService(fixture.db);
  const first = await service.awardMessage(GUILD, A, at(0), '200000000000000001');
  const blocked = await service.awardMessage(GUILD, A, at(59), '200000000000000001');
  const second = await service.awardMessage(GUILD, A, at(60), '200000000000000001');

  assert.equal(first.awarded, 15);
  assert.equal(blocked.awarded, 0);
  assert.equal(second.awarded, 15);
  assert.equal((await service.profile(GUILD, A)).messageXp, 30);
  const awards = await fixture.db
    .prepare(`SELECT source, xp FROM xp_awards WHERE guild_id = ? ORDER BY id`)
    .all<{ source: string; xp: number }>(GUILD);
  assert.deepEqual(awards.map((row) => ({ ...row })), [
    { source: 'message', xp: 15 },
    { source: 'message', xp: 15 },
  ]);
});

test('voice XP uses completed minutes and the voice cooldown', async () => {
  const service = new LevelingService(fixture.db);
  const first = await service.awardVoice(GUILD, A, 125, at(0), '300000000000000001');
  const blocked = await service.awardVoice(GUILD, A, 600, at(30), '300000000000000001');
  const second = await service.awardVoice(GUILD, A, 60, at(60), '300000000000000001');

  assert.equal(first.awarded, 10);
  assert.equal(blocked.awarded, 0);
  assert.equal(second.awarded, 5);
  assert.equal((await service.profile(GUILD, A)).voiceXp, 15);
});

test('leaderboard and rank break XP ties by member id', async () => {
  const service = new LevelingService(fixture.db);
  await service.importMee6(GUILD, [
    { memberId: B, xp: 100 },
    { memberId: A, xp: 100 },
  ], at(0));

  assert.deepEqual((await service.leaderboard(GUILD)).map((r) => [r.memberId, r.rank]), [
    [A, 1],
    [B, 2],
  ]);
  assert.equal((await service.profile(GUILD, B)).rank, 2);
});

test('re-import is idempotent and corrected imports preserve organic XP', async () => {
  const service = new LevelingService(fixture.db);
  const first = await service.importMee6(GUILD, [
    { memberId: A, xp: 100 },
    { memberId: A, xp: 90 },
    { memberId: B, xp: 50 },
  ], at(0));
  await service.awardMessage(GUILD, A, at(60));
  const repeated = await service.importMee6(GUILD, [
    { memberId: A, xp: 100 },
    { memberId: B, xp: 50 },
  ], at(120));
  const corrected = await service.importMee6(GUILD, [
    { memberId: A, xp: 120 },
    { memberId: B, xp: 50 },
  ], at(180));

  assert.deepEqual(first, {
    sourceRows: 3,
    uniqueMembers: 2,
    inserted: 2,
    updated: 0,
    unchanged: 0,
    duplicateRows: 1,
    totalImportedXp: 150,
  });
  assert.equal(repeated.unchanged, 2);
  assert.equal(corrected.updated, 1);
  const profile = await service.profile(GUILD, A);
  assert.equal(profile.importedXp, 120);
  assert.equal(profile.messageXp, 15);
  assert.equal(profile.xp, 135);
});

test('concurrent identical imports remain idempotent', async () => {
  const first = new LevelingService(fixture.db);
  const second = new LevelingService(fixture.db);
  const rows = [{ memberId: A, xp: 100 }];

  const summaries = await Promise.all([
    first.importMee6(GUILD, rows, at(0)),
    second.importMee6(GUILD, rows, at(1)),
  ]);

  assert.equal(summaries.reduce((sum, summary) => sum + summary.inserted, 0), 1);
  assert.equal(summaries.reduce((sum, summary) => sum + summary.unchanged, 0), 1);
  assert.equal((await first.profile(GUILD, A)).xp, 100);
});

test('stored XP ceiling rejects unsafe imports and awards without consuming cooldown', async () => {
  const service = new LevelingService(fixture.db);
  await service.importMee6(GUILD, [{ memberId: A, xp: MAX_STORED_XP }], at(0));

  const blocked = await service.awardMessage(GUILD, A, at(60));
  assert.equal(blocked.awarded, 0);
  assert.equal(blocked.totalXp, MAX_STORED_XP);
  assert.equal(
    Number((await fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM xp_cooldowns WHERE guild_id = ? AND member_id = ?`)
      .get<{ count: number }>(GUILD, A))?.count ?? 0),
    0,
  );
  await assert.rejects(
    service.importMee6(GUILD, [
      { memberId: A, xp: MAX_STORED_XP },
      { memberId: B, xp: 1 },
    ], at(120)),
    /total imported XP exceeds the safe integer range/,
  );
});

test('corrected imports cannot overflow organic plus imported XP', async () => {
  const service = new LevelingService(fixture.db);
  await service.importMee6(GUILD, [{ memberId: A, xp: MAX_STORED_XP - 15 }], at(0));
  await service.awardMessage(GUILD, A, at(60));

  await assert.rejects(
    service.importMee6(GUILD, [{ memberId: A, xp: MAX_STORED_XP }], at(120)),
    /imported XP plus organic XP exceeds/,
  );
  const profile = await service.profile(GUILD, A);
  assert.equal(profile.xp, MAX_STORED_XP);
  assert.equal(profile.importedXp, MAX_STORED_XP - 15);
  assert.equal(profile.messageXp, 15);
});

test('role rewards replace atomically and rank text is user readable', async () => {
  const service = new LevelingService(fixture.db);
  await service.replaceRoleRewards(GUILD, [
    { level: 10, roleId: '400000000000000010' },
    { level: 5, roleId: '400000000000000005' },
  ]);
  assert.deepEqual(await service.roleRewards(GUILD), [
    { level: 5, roleId: '400000000000000005' },
    { level: 10, roleId: '400000000000000010' },
  ]);
  await service.replaceRoleRewards(GUILD, [{ level: 20, roleId: '400000000000000020' }]);
  assert.deepEqual(await service.roleRewards(GUILD), [
    { level: 20, roleId: '400000000000000020' },
  ]);

  const text = rankText(await service.profile(GUILD, A), 'Player One');
  assert.match(text, /Player One/);
  assert.match(text, /Rank \*\*Unranked\*\* \(no XP recorded\)/);
  assert.doesNotMatch(text, /Rank \*\*#/);
  assert.match(text, /to level 1/);
});

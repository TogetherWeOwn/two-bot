import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/store/driver.ts';
import { LevelingService, levelForXp, totalXpForLevel } from '../src/leveling/service.ts';
import { rankText } from '../src/leveling/discord.ts';

const GUILD = '1545644954272137297';
const OTHER_GUILD = '1545644954272137298';
const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';
const ABSENT = '100000000000000004';

interface MemberRow {
  guildId: string;
  memberId: string;
  xp: number;
  message_xp: number;
  voice_xp: number;
  imported_xp: number;
}

function member(memberId: string, xp: number, guildId = GUILD): MemberRow {
  return { guildId, memberId, xp, message_xp: 0, voice_xp: 0, imported_xp: xp };
}

function readOnlyDb(rows: MemberRow[]): Db {
  return {
    prepare(sql) {
      const query = sql.replace(/\s+/g, ' ').trim();
      assert.match(query, /^SELECT /, 'profile must not prepare a mutation');
      return {
        async get<T>(...params: unknown[]) {
          const [guildId, xp, equalXp, memberId] = params;
          const population = rows.filter((row) => row.guildId === guildId);
          let result: unknown;
          if (query === 'SELECT xp, message_xp, voice_xp, imported_xp FROM member_levels WHERE guild_id = ? AND member_id = ?') {
            result = population.find((row) => row.memberId === params[1]);
          } else if (query === 'SELECT COUNT(*) AS rank FROM member_levels WHERE guild_id = ? AND (xp > ? OR (xp = ? AND member_id < ?))') {
            result = { rank: population.filter((row) => row.xp > Number(xp)
              || (row.xp === equalXp && row.memberId < String(memberId))).length };
          } else if (query === 'SELECT COUNT(*) AS count FROM member_levels WHERE guild_id = ?') {
            result = { count: population.length };
          } else {
            assert.fail(`unexpected profile query: ${query}`);
          }
          return result as T | undefined;
        },
        async all() { assert.fail('profile must not read unrelated collections'); },
        async run() { assert.fail('profile must not write'); },
      };
    },
    async exec() { assert.fail('profile must not execute raw SQL'); },
    async transaction() { assert.fail('profile must not open a write transaction'); },
    async close() {},
  };
}

for (const population of [
  [],
  [member(A, 100)],
  [member(A, 300), member(B, 200), member(C, 100)],
  [member(A, 0), member(B, 0), member(C, 100)],
]) {
  test(`absent member is unranked without writes in population ${population.map((row) => row.xp).join(',') || 'empty'}`, async () => {
    const rows = [...population, member(ABSENT, 500, OTHER_GUILD)];
    const before = structuredClone(rows);
    const service = new LevelingService(readOnlyDb(rows));
    for (let view = 0; view < 2; view++) {
      const profile = await service.profile(GUILD, ABSENT);
      assert.equal(profile.rank, null);
      assert.equal(profile.memberCount, population.length);
      assert.equal(profile.xp, 0);
      assert.equal(profile.level, 0);
      assert.equal(profile.messageXp, 0);
      assert.equal(profile.voiceXp, 0);
      assert.equal(profile.importedXp, 0);
      assert.equal(profile.nextLevelXp, totalXpForLevel(1));
      const text = rankText(profile, 'New Player');
      assert.match(text, /\*\*New Player\*\*/);
      assert.match(text, /Rank \*\*Unranked\*\* \(no XP recorded\)/);
      assert.doesNotMatch(text, /Rank \*\*#/);
      assert.match(text, /XP \*\*0\*\* · 0\/100 this level · \*\*100\*\* to level 1/);
    }
    assert.deepEqual(rows, before);
  });
}

for (const population of [
  [member(A, 0)],
  [member(C, 0), member(B, 100), member(A, 0)],
  [member(C, 100), member(B, 300), member(A, 100)],
]) {
  test(`stored members keep bounded XP and member-ID ranks in population ${population.map((row) => row.xp).join(',')}`, async () => {
    const rows = [...population, member(A, 500, OTHER_GUILD)];
    const before = structuredClone(rows);
    const service = new LevelingService(readOnlyDb(rows));
    const ordered = [...population].sort((a, b) => b.xp - a.xp || a.memberId.localeCompare(b.memberId));
    for (const [index, row] of ordered.entries()) {
      const profile = await service.profile(GUILD, row.memberId);
      assert.equal(profile.rank, index + 1);
      assert.equal(profile.memberCount, population.length);
      assert.ok(profile.rank !== null);
      assert.ok(profile.rank >= 1 && profile.rank <= profile.memberCount);
      assert.equal(profile.xp, row.xp);
      assert.equal(profile.importedXp, row.imported_xp);
      assert.equal(profile.level, levelForXp(row.xp));
      assert.equal(profile.nextLevelXp, totalXpForLevel(profile.level + 1));
      const text = rankText(profile, 'Stored Player');
      assert.ok(text.includes(`Rank **#${index + 1}** of **${population.length}**`));
      assert.doesNotMatch(text, /Unranked/);
    }
    assert.deepEqual(rows, before);
  });
}

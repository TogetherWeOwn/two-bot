/**
 * TOG-3481 acceptance for the reward-role dry run, by execution.
 *
 * The card asks for a fixture that exercises mapped AND unmapped reward roles,
 * deterministic counts, a malformed-fixture failure, and no writes. The first
 * three are asserted here against the shipped fixtures; the CLI and the
 * "nothing was written" half are in test/e2e.levelrewardprobe.test.ts, which
 * needs a database to prove the absence of a write.
 *
 * The counts below are written out one reason at a time on purpose. Asserting
 * only `mapped: 2, unmapped: 5` would still pass if two reasons swapped places,
 * and the reason is the entire product here - "5 of your roles will not work"
 * is not actionable, "this one is above the bot, that one was deleted" is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMee6Export } from '../src/leveling/importManifest.ts';
import {
  Mee6RewardExportError,
  parseMee6RoleRewards,
  planRewardRoleImport,
  type Mee6RoleReward,
} from '../src/leveling/rewardImport.ts';
import type { PartialRole } from '../src/staging/provision.ts';

const GUILD = '900000000000000000';
const BOT_ID = '900000000000000001';
const EXPORT_PATH = new URL('./fixtures/mee6-export-role-rewards.json', import.meta.url).pathname;
const ROLES_PATH = new URL('./fixtures/mee6-guild-roles.json', import.meta.url).pathname;

const exportText = readFileSync(EXPORT_PATH, 'utf8');
const roles: PartialRole[] = JSON.parse(readFileSync(ROLES_PATH, 'utf8')).roles;

function plan(rewards: readonly Mee6RoleReward[], overrides: Partial<Parameters<typeof planRewardRoleImport>[2]> = {}) {
  return planRewardRoleImport(GUILD, rewards, { roles, botId: BOT_ID, ...overrides });
}

test('the fixture is one real export: XP and reward parsers both read it', () => {
  // If these two ever disagree about the same file, the probe is reporting on
  // something the importer would not accept, and the dry run is worthless.
  assert.equal(parseMee6Export(exportText).length, 3);
  assert.equal(parseMee6RoleRewards(exportText).length, 7);
});

test('parseMee6Export strips a leading UTF-8 BOM (TOG-9917)', () => {
  // Windows editors / Excel round-trips commonly leave a BOM; without the
  // strip this throws "file is not valid JSON" on otherwise valid JSON.
  assert.equal(parseMee6Export('\uFEFF' + exportText).length, 3);
});

test('every reward in the fixture is classified, once, with its reason', () => {
  const report = plan(parseMee6RoleRewards(exportText));

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.counts.rewardsIn, 7);
  assert.equal(report.counts.mapped, 2);
  assert.equal(report.counts.unmapped, 5);
  assert.ok(report.counts.balances);
  assert.deepEqual(report.counts.byReason, {
    role_absent: 1,
    role_managed: 1,
    above_bot_role: 1,
    duplicate_level: 1,
    duplicate_role: 1,
  });

  assert.deepEqual(
    report.mapped.map((r) => [r.level, r.roleId, r.roleName]),
    [
      [5, '900000000000000020', 'Level 5'],
      [10, '900000000000000021', 'Level Ten'],
    ],
  );
  assert.deepEqual(
    report.unmapped.map((r) => [r.level, r.reason]),
    [
      [5, 'duplicate_level'],
      [15, 'role_absent'],
      [20, 'role_managed'],
      [25, 'above_bot_role'],
      [30, 'duplicate_role'],
    ],
  );
  assert.deepEqual(report.apply, [
    { level: 5, roleId: '900000000000000020' },
    { level: 10, roleId: '900000000000000021' },
  ]);
});

test('a role renamed since the export maps, and says so', () => {
  const report = plan(parseMee6RoleRewards(exportText));
  const renamed = report.mapped.find((r) => r.level === 10)!;
  // The export remembers "Level 10"; the guild now calls it "Level Ten". The
  // id is the identity, so this maps - but an operator reading a reward list
  // full of stale names needs to know which ones moved.
  assert.equal(renamed.renamedFrom, 'Level 10');
  assert.equal(report.mapped.find((r) => r.level === 5)!.renamedFrom, undefined);
});

test('each skip reason names the number or role that lost', () => {
  const byReason = new Map(plan(parseMee6RoleRewards(exportText)).unmapped.map((r) => [r.reason, r.detail]));
  assert.match(byReason.get('role_absent')!, /900000000000000099/);
  assert.match(byReason.get('role_managed')!, /Server Booster/);
  assert.match(byReason.get('above_bot_role')!, /position 80.*Owen QA Test.*50/s);
  assert.match(byReason.get('duplicate_level')!, /PRIMARY KEY/);
  assert.match(byReason.get('duplicate_role')!, /UNIQUE/);
});

test('the report is identical for any permutation of the same export', () => {
  const rewards = parseMee6RoleRewards(exportText);
  const reversed = [...rewards].reverse();
  // Determinism is not cosmetic: an operator diffs two runs to see what
  // changed in their server, and file order changing under them would make
  // every diff unreadable.
  assert.deepEqual(plan(reversed), plan(rewards));
});

test('the guild owner bypasses hierarchy, exactly as evaluateHierarchy does', () => {
  const report = plan(parseMee6RoleRewards(exportText), { ownerId: BOT_ID });
  assert.ok(report.ownerBypass);
  // "Staff" at position 80 becomes grantable; the managed and absent roles do
  // not, because ownership does not conjure a role or unmanage one.
  assert.deepEqual(report.counts.byReason, {
    role_absent: 1,
    role_managed: 1,
    above_bot_role: 0,
    duplicate_level: 1,
    duplicate_role: 1,
  });
  assert.equal(report.counts.mapped, 3);
});

test('a bot with no role in the guild can grant nothing', () => {
  const report = planRewardRoleImport(GUILD, parseMee6RoleRewards(exportText), {
    roles: roles.filter((r) => !r.tags?.bot_id),
    botId: BOT_ID,
  });
  assert.equal(report.botRoleId, null);
  assert.equal(report.counts.mapped, 0);
  // Five, not four: with nothing mappable no level or role is ever claimed, so
  // the two rewards that are duplicates in the fixture are reported for the
  // reason that actually stops them - the bot cannot grant anything at all.
  assert.equal(report.counts.byReason.above_bot_role, 5);
  assert.equal(report.counts.byReason.duplicate_level, 0);
  assert.equal(report.counts.byReason.duplicate_role, 0);
  assert.match(report.unmapped[0]!.detail, /re-invite the bot/);
});

test('a role at exactly the bot position is refused, not granted', () => {
  // Discord compares strictly: equal position is NOT grantable. An off-by-one
  // here would report a reward as fine and have it fail at every level-up.
  const atBotPosition = roles.map((r) => (r.name === 'Level 5' ? { ...r, position: 50 } : r));
  const report = planRewardRoleImport(GUILD, [{ level: 5, roleId: '900000000000000020' }], {
    roles: atBotPosition,
    botId: BOT_ID,
  });
  assert.equal(report.counts.mapped, 0);
  assert.equal(report.unmapped[0]!.reason, 'above_bot_role');
});

test('duplicates are judged on what would be written, not on what is listed', () => {
  // Level 5 names a deleted role first, then a good one. The good one maps;
  // calling it a duplicate would be a lie, because one row is written and
  // nothing is lost.
  const report = plan([
    { level: 5, roleId: '900000000000000099' },
    { level: 5, roleId: '900000000000000020' },
  ]);
  assert.equal(report.counts.mapped, 1);
  assert.equal(report.counts.byReason.duplicate_level, 0);
  assert.equal(report.counts.byReason.role_absent, 1);
  assert.deepEqual(report.apply, [{ level: 5, roleId: '900000000000000020' }]);
});

test('the delta against stored rewards names adds, changes and removals', () => {
  const report = plan(parseMee6RoleRewards(exportText), {
    storedRewards: [
      { level: 5, roleId: '900000000000000024' },
      { level: 99, roleId: '900000000000000023' },
    ],
  });
  // replaceRoleRewards deletes the guild's rows first, so level 99 disappears
  // on apply. An operator must see that before they reach for it.
  assert.deepEqual(report.delta, {
    added: [{ level: 10, roleId: '900000000000000021' }],
    changed: [{ level: 5, from: '900000000000000024', to: '900000000000000020' }],
    removed: [{ level: 99, roleId: '900000000000000023' }],
    unchanged: [],
  });
});

test('no stored rewards supplied means no delta claimed', () => {
  assert.equal(plan(parseMee6RoleRewards(exportText)).delta, null);
});

test('an export with no role_rewards is empty, not an error', () => {
  // Plenty of servers level without reward roles. That is not a malformed file.
  assert.deepEqual(parseMee6RoleRewards(JSON.stringify({ players: [] })), []);
  assert.deepEqual(parseMee6RoleRewards(JSON.stringify({ role_rewards: null })), []);
});

test('the flattened role shape is accepted alongside MEE6 nesting', () => {
  assert.deepEqual(parseMee6RoleRewards(JSON.stringify({ role_rewards: [{ level: 3, role_id: '900000000000000020' }] })), [
    { level: 3, roleId: '900000000000000020', roleName: undefined },
  ]);
});

test('a malformed export reports every problem, not just the first', () => {
  const bad = JSON.stringify({
    role_rewards: [
      { rank: 0, role: { id: '900000000000000020' } },
      { rank: 5, role: { id: 'not-a-snowflake' } },
      { rank: 7 },
      'nonsense',
    ],
  });
  let error: Mee6RewardExportError | null = null;
  try {
    parseMee6RoleRewards(bad);
  } catch (caught) {
    error = caught as Mee6RewardExportError;
  }
  assert.ok(error instanceof Mee6RewardExportError);
  // Four bad rows, four problems. Fixing an export one error per run is how a
  // migration takes a day.
  assert.equal(error.problems.length, 4);
  assert.match(error.problems[0]!, /invalid level: 0/);
  assert.match(error.problems[1]!, /invalid Discord role id: not-a-snowflake/);
  assert.match(error.problems[2]!, /no role id/);
  assert.match(error.problems[3]!, /is not an object/);
});

test('a role_rewards key that is not an array is malformed', () => {
  assert.throws(() => parseMee6RoleRewards(JSON.stringify({ role_rewards: {} })), Mee6RewardExportError);
  assert.throws(() => parseMee6RoleRewards('['), Mee6RewardExportError);
  assert.throws(() => parseMee6RoleRewards('[]'), Mee6RewardExportError);
});

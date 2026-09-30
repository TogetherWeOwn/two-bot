/** Guild env wiring and pre-open refusal through the real CLI, without a DB. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { DashboardFixture } from './helpers/dashboardDbFixture.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/dashboard.ts', import.meta.url));
const FIXTURE = new URL('./helpers/dashboardCliFixture.ts', import.meta.url).href;
const GUILD = 'dashboard-target';
const FOREIGN = 'dashboard-foreign';

async function cli(guild: string | null, args = ['--json']) {
  const at = '2026-09-29T12:00:00.000Z';
  const fixture: DashboardFixture = {
    members: [GUILD, FOREIGN].map((guild_id) => ({
      guild_id, is_bot: false, member_id: 'same-id', joined_at: at, join_source: 'vanity',
      gate_cleared_at: null, first_message_at: null, first_voice_at: null,
      last_active_at: null, left_at: null,
    })),
    events: [GUILD, FOREIGN].map((guild_id, id) => ({
      id, guild_id, event_type: 'member_join', member_id: 'same-id',
      occurred_at: at, recorded_at: at, source: 'vanity', metadata: null,
    })),
  };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TWO_DATABASE_URL: 'fixture://dashboard',
    // An absent fixture directory ensures no ambient audit snapshot is read.
    TWO_DATA_DIR: fileURLToPath(new URL('./helpers/no-dashboard-data', import.meta.url)),
    DASHBOARD_FIXTURE: JSON.stringify(fixture),
  };
  if (guild !== null) env.DISCORD_GUILD_ID = guild;
  try {
    const out = await run(process.execPath, ['--import', FIXTURE, SCRIPT, ...args], { env, timeout: 10_000 });
    return { code: 0, ...out };
  } catch (error) {
    const out = error as { code?: number; stdout?: string; stderr?: string };
    return { code: out.code ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  }
}

test('CLI passes the trimmed configured guild to every dashboard read', async () => {
  const out = await cli(`  ${GUILD}\t`);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stderr, 'fixture: openDb\nfixture: close\n');
  const data = JSON.parse(out.stdout);
  assert.equal(data.guildId, GUILD, 'newest foreign event must not relabel the dashboard');
  assert.equal(data.humansInServer, 1);
  assert.equal(data.sourcesAllTime[0].joins, 1, 'same member ID in two guilds is not two target joins');
});

for (const guild of [null, '', ' \t\n ']) {
  for (const args of [['--json'], ['--serve']]) {
    test(`${args[0]} missing/empty guild ${JSON.stringify(guild)} refuses before openDb`, async () => {
      const out = await cli(guild, args);
      assert.equal(out.code, 1);
      assert.equal(out.stdout, '');
      assert.equal(out.stderr, 'dashboard: DISCORD_GUILD_ID is not set.\n');
    });
  }
}

test('--help remains available without a configured guild or database', async () => {
  const out = await cli(null, ['--help']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^Usage:/);
  assert.equal(out.stderr, '');
});

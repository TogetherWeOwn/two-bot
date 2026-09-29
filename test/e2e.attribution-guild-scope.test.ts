/**
 * TOG-9555: attribution is scoped to one guild.
 *
 * scripts/attribution.ts had zero `guild_id` predicates, so a database holding
 * several guilds summed every guild into one report - the same latent bug
 * f0caf422 fixed for scripts/funnel.ts (TOG-8738). This seeds one guild's
 * community, asserts the hand-computed CSV, then mirrors every event and
 * member row under a foreign guild and asserts the report does not move.
 *
 * Fixture (t0 = now - 40 days, GUILD constant below, default 90-day window):
 *
 *   events:
 *     2x invite_click            (source invite:CODE)
 *     4x member_join             a, b, bot1 (invite:CODE), c (unknown)
 *   members:
 *     a   voice on day 1, active day 20  -> AM7 voice, AM30 proven-in-window
 *     b   never did anything             -> joins, neither AM7 nor AM30
 *     c   3rd message day 2, active d20  -> AM7 messages exact, AM30 in-window
 *     bot1 is_bot=1                      -> dropped from the report
 *   invite_campaigns: one row (scope-link -> CODE)
 *   invite_snapshots: one row (CODE)
 *
 * Hand-computed CSV (matured: 40 days, so every join is AM7- and AM30-eligible):
 *
 *   invite:CODE  clicks 2, joins 2 (a, b; the bot is dropped), AM7 1/2 (a on
 *                voice), AM30 1/1 proven-in-window
 *   unknown      clicks 0, joins 1 (c), AM7 1/1 (messages exact), AM30 1/1
 *   TOTAL        clicks 2, joins 3, AM7 2/3 (1 voice + 1 messages, no proxy),
 *                AM30 2/2 both proven in-window
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/attribution.ts', import.meta.url).pathname;
const GUILD = '1545644954272137297';
const OTHER_GUILD = '999999999999999002';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let harness: TestDb;
let dbEnv: Record<string, string>;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
    // TOG-9555: the attribution report is scoped to one guild and fails fast
    // without it. The fixture seeds GUILD, so this is the server reported on.
    DISCORD_GUILD_ID: GUILD,
  };
});

after(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  await harness.db.exec(`DELETE FROM invite_campaigns`);
});

async function cli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...dbEnv };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function seedFixture(): Promise<void> {
  const db = harness.db;
  const t0 = Date.now() - 40 * DAY;

  const event = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let k = 0;
  const key = () => `attribution-guild-scope-${++k}`;

  await event.run('invite_click', null, GUILD, iso(t0), 'invite:CODE', null, key());
  await event.run('invite_click', null, GUILD, iso(t0 + 1000), 'invite:CODE', null, key());
  await event.run('member_join', 'a', GUILD, iso(t0), 'invite:CODE', null, key());
  await event.run('member_join', 'b', GUILD, iso(t0 + 60_000), 'invite:CODE', null, key());
  await event.run('member_join', 'c', GUILD, iso(t0 + 120_000), 'unknown', null, key());
  await event.run('member_join', 'bot1', GUILD, iso(t0 + 180_000), 'invite:CODE', null, key());

  const member = db.prepare(
    `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, third_message_at,
      first_voice_at, last_active_at, left_at, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await member.run(GUILD, 'a', iso(t0), null, null, iso(t0 + DAY), iso(t0 + 20 * DAY), null, 0);
  await member.run(GUILD, 'b', iso(t0), null, null, null, null, null, 0);
  await member.run(
    GUILD, 'c', iso(t0), iso(t0 + DAY), iso(t0 + 2 * DAY), null, iso(t0 + 20 * DAY), null, 0,
  );
  await member.run(GUILD, 'bot1', iso(t0), null, null, null, null, null, 1);

  await db
    .prepare(
      `INSERT INTO invite_campaigns (slug, label, invite_code, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('scope-link', 'Scope listing', 'CODE', iso(t0));
  await db
    .prepare(
      `INSERT INTO invite_snapshots (guild_id, code, uses, channel_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(GUILD, 'CODE', 3, null, iso(t0));
}

const EXPECTED_CSV = [
  'source,clicks,joins,joins_inexact,am7,am7_eligible,am7_voice,am7_messages,am7_message_proxy,am30,am30_eligible,am30_proven_in_window,am30_proven_later',
  'invite:CODE,2,2,0,1,2,1,0,0,1,1,1,0',
  'unknown,0,1,0,1,1,0,1,0,1,1,1,0',
  'TOTAL,2,3,0,2,3,1,1,0,2,2,2,0',
].join('\n');

test('fails fast without DISCORD_GUILD_ID', async () => {
  const r = await cli(['--csv'], { DISCORD_GUILD_ID: undefined });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DISCORD_GUILD_ID is not set - there is no server to report on\./);
});

test('one guild reports its hand-computed numbers', async () => {
  await seedFixture();
  const r = await cli(['--csv']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), EXPECTED_CSV);
});

test('a second guild in the same database does not move a single number', async () => {
  await seedFixture();
  const baseline = await cli(['--csv']);
  assert.equal(baseline.code, 0, baseline.stdout + baseline.stderr);
  assert.equal(baseline.stdout.trim(), EXPECTED_CSV);

  // TOG-9555: mirror every fixture row under a foreign guild - equal size, so
  // any unscoped query visibly moves the report.
  const db = harness.db;
  const rows = await db
    .prepare(`SELECT event_type, member_id, occurred_at, source, metadata FROM events`)
    .all<{
      event_type: string; member_id: string | null; occurred_at: string;
      source: string; metadata: string | null;
    }>();
  const insEvent = db.prepare(
    `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i]!;
    await insEvent.run(
      e.event_type, e.member_id, OTHER_GUILD, e.occurred_at, e.source, e.metadata,
      `attribution-guild-scope-other-${i}`,
    );
  }
  const members = await db
    .prepare(
      `SELECT member_id, joined_at, first_message_at, third_message_at, first_voice_at,
        last_active_at, left_at, is_bot FROM members`,
    )
    .all<{
      member_id: string; joined_at: string | null; first_message_at: string | null;
      third_message_at: string | null; first_voice_at: string | null;
      last_active_at: string | null; left_at: string | null; is_bot: number;
    }>();
  const insMember = db.prepare(
    `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, third_message_at,
      first_voice_at, last_active_at, left_at, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of members) {
    await insMember.run(
      OTHER_GUILD, m.member_id, m.joined_at, m.first_message_at, m.third_message_at,
      m.first_voice_at, m.last_active_at, m.left_at, m.is_bot,
    );
  }
  assert.equal(rows.length, 6, 'precondition: the fixture seeds 6 events');
  assert.equal(members.length, 4, 'precondition: the fixture seeds 4 members');

  const mirrored = await cli(['--csv']);
  assert.equal(mirrored.code, 0, mirrored.stdout + mirrored.stderr);
  assert.equal(mirrored.stdout, baseline.stdout, 'foreign guild rows must not move the report');
});

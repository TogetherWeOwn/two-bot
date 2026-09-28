/**
 * The staging readiness checks. No token, no network, no database.
 *
 * These cover the two cases nobody can safely reproduce by hand: being handed
 * the LIVE bot's token in the staging variable (which happened, on 2026-08-19)
 * and pointing TWO_STAGING_DATABASE_URL at the live database. The second one
 * has no undo at all, so it is tested rather than trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_CODE,
  databaseStateChecks,
  stagingEnvChecks,
  verdict,
  type CheckId,
  type Env,
  type ReadinessCheck,
} from '../src/staging/readiness.ts';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID } from '../src/staging/spec.ts';
import { EXPECTED_FUNNEL, TEST_NOW, seedFixtures } from '../src/staging/fixtures.ts';
import { openTestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import type { EventType } from '../src/core/events.ts';

/** A token is base64(application_id).timestamp.hmac - the rest is not read. */
const tokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.Gxxxxx.notarealsecret`;

const STAGING_TOKEN = tokenFor(STAGING_BOT_APPLICATION_ID);
const LIVE_TOKEN = tokenFor(LIVE_BOT_APPLICATION_ID);

const GOOD: Env = {
  DISCORD_STAGING_BOT_TOKEN: STAGING_TOKEN,
  DISCORD_STAGING_GUILD_ID: '999000111222333444',
  TWO_STAGING_DATABASE_URL: 'postgres://qa:pw@db.example.com:5432/two_staging',
};

const get = (env: Env, id: CheckId): ReadinessCheck =>
  stagingEnvChecks(env).find((c) => c.id === id)!;

test('a fully configured environment is ready', () => {
  const checks = stagingEnvChecks(GOOD);
  assert.deepEqual(
    checks.map((c) => c.status),
    ['ok', 'ok', 'ok'],
  );
  assert.equal(verdict(checks), 'ready');
  assert.equal(EXIT_CODE[verdict(checks)], 0);
});

test('a missing token is blocked on a named owner, not reported as a mistake', () => {
  const c = get({ ...GOOD, DISCORD_STAGING_BOT_TOKEN: undefined }, 'token');
  assert.equal(c.status, 'blocked');
  assert.match(c.owner ?? '', /founder/i);
  assert.match(c.owner ?? '', /TWO-21/);
  assert.match(c.action ?? '', /discord_staging_bot_token/);
});

test('the live bot token in the staging variable is caught and named', () => {
  const c = get({ ...GOOD, DISCORD_STAGING_BOT_TOKEN: LIVE_TOKEN }, 'token');
  assert.equal(c.status, 'blocked');
  assert.match(c.detail, new RegExp(LIVE_BOT_APPLICATION_ID));
  assert.match(c.action ?? '', /rebind/i);
});

test('no check ever echoes the token it was given', () => {
  for (const token of [LIVE_TOKEN, STAGING_TOKEN]) {
    const printed = JSON.stringify(stagingEnvChecks({ ...GOOD, DISCORD_STAGING_BOT_TOKEN: token }));
    assert.equal(printed.includes('notarealsecret'), false);
  }
});

// This test used to assert the opposite - that a third application was 'ok'
// with a note - on the reasoning that anything which is not the live bot is
// harmless. On 2026-08-20 the token bound to us was a third application that
// was sitting in the live TWO guild, and this check printed "Continuing".
// An identity we cannot name blocks.
test('a token from some third application blocks on a named owner', () => {
  const c = get({ ...GOOD, DISCORD_STAGING_BOT_TOKEN: tokenFor('1234567890123456789') }, 'token');
  assert.equal(c.status, 'blocked');
  assert.match(c.detail, /1234567890123456789/);
  assert.match(c.owner ?? '', /founder/i);
});

// These two used to assert that a missing guild was a `fix` when the token
// worked and `blocked` when it did not - i.e. that the token decided the
// answer, because the bot was going to build the server itself. Measured on
// 2026-09-05 it cannot: POST /guilds returns code 20001 to any bot token. A
// perfect token no longer helps, so the honest status is `blocked` on a human
// either way. Calling it a `fix` sent QA to re-run a command that could never
// succeed - the exact failure this module exists to prevent.
test('a missing guild is blocked on a human whether or not the token works', () => {
  for (const token of [GOOD.DISCORD_STAGING_BOT_TOKEN, undefined]) {
    const c = get(
      { ...GOOD, DISCORD_STAGING_GUILD_ID: undefined, DISCORD_STAGING_BOT_TOKEN: token },
      'guild',
    );
    assert.equal(c.status, 'blocked', `token present: ${Boolean(token)}`);
    assert.ok(c.owner, 'a blocked check must name who unblocks it');
    // Never point at the create path again - that is the regression.
    assert.doesNotMatch(c.action ?? '', /--apply/);
  }
});

test('the missing-guild action tells a human how to make the server themselves', () => {
  const c = get({ ...GOOD, DISCORD_STAGING_GUILD_ID: undefined }, 'guild');
  assert.match(c.detail, /20001/, 'say why no script can do this');
  assert.match(c.action ?? '', /DISCORD_STAGING_GUILD_ID/);
});

test('the live guild id in the staging variable is a fix, not a wait', () => {
  const c = get({ ...GOOD, DISCORD_STAGING_GUILD_ID: LIVE_GUILD_ID }, 'guild');
  assert.equal(c.status, 'fix');
  assert.match(c.detail, /LIVE/);
});

test('a missing database is the keyboard-holder\'s job, not a wait on anyone', () => {
  // Was `blocked` on the founder until TOG-45 provisioned staging
  // (2026-08-25; then `two_bot_staging`, canonical `twobot_staging` since TOG-7033).
  // The host exists and the schema is applied, so an unset
  // variable is one export - naming an owner here would park QA behind a
  // person who has nothing left to do.
  const c = get({ ...GOOD, TWO_STAGING_DATABASE_URL: undefined }, 'database');
  assert.equal(c.status, 'fix');
  assert.equal(c.owner, undefined);
  assert.match(c.action ?? '', /twobot_staging/);
});

test('a SQLite path is refused - staging runs the same engine as live', () => {
  const c = get({ ...GOOD, TWO_STAGING_DATABASE_URL: './staging.db' }, 'database');
  assert.equal(c.status, 'fix');
});

test('a database not named like staging is refused', () => {
  const c = get({ ...GOOD, TWO_STAGING_DATABASE_URL: 'postgres://u:p@h:5432/two_prod' }, 'database');
  assert.equal(c.status, 'fix');
  assert.match(c.detail, /two_prod/);
});

test('"two_test" is a staging-shaped name', () => {
  const c = get({ ...GOOD, TWO_STAGING_DATABASE_URL: 'postgres://u:p@h:5432/two_test' }, 'database');
  assert.equal(c.status, 'ok');
});

test('the same database under different credentials is still the live one', () => {
  const c = get(
    {
      ...GOOD,
      TWO_STAGING_DATABASE_URL: 'postgres://qa:qapw@db.example.com:5432/two_staging',
      TWO_DATABASE_URL: 'postgres://bot:botpw@db.example.com:5432/two_staging',
    },
    'database',
  );
  assert.equal(c.status, 'fix');
  assert.match(c.action ?? '', /no undo/i);
});

test('a different database on the same server is fine - that is the plan', () => {
  const c = get(
    {
      ...GOOD,
      TWO_STAGING_DATABASE_URL: 'postgres://u:p@db.example.com:5432/two_staging',
      TWO_DATABASE_URL: 'postgres://u:p@db.example.com:5432/two',
    },
    'database',
  );
  assert.equal(c.status, 'ok');
});

test('the default port is filled in before comparing targets', () => {
  const c = get(
    {
      ...GOOD,
      TWO_STAGING_DATABASE_URL: 'postgres://u:p@db.example.com/two_staging',
      TWO_DATABASE_URL: 'postgres://u:p@db.example.com:5432/two_staging',
    },
    'database',
  );
  assert.equal(c.status, 'fix');
});

test('a wrong value outranks a missing one - it can bite today', () => {
  const checks = stagingEnvChecks({
    DISCORD_STAGING_BOT_TOKEN: undefined,
    DISCORD_STAGING_GUILD_ID: LIVE_GUILD_ID,
    TWO_STAGING_DATABASE_URL: undefined,
  });
  assert.equal(verdict(checks), 'fix');
  assert.equal(EXIT_CODE.fix, 1);
});

test('waiting on someone exits 3, distinctly from a setup error', () => {
  // The database is set here on purpose. Since TOG-45 it is settable without
  // anyone's help, so a bare `{}` environment carries a real `fix` and would
  // score `fix` by the rule below - correctly, but it would no longer be
  // testing what this test is about. The pure wait is: database done, token
  // not bound.
  const checks = stagingEnvChecks({ TWO_STAGING_DATABASE_URL: GOOD.TWO_STAGING_DATABASE_URL });
  assert.equal(verdict(checks), 'blocked');
  assert.equal(EXIT_CODE[verdict(checks)], 3);
  assert.equal(checks.every((c) => c.status !== 'blocked' || c.owner), true);
});

test('an empty environment now has something the operator can do themselves', () => {
  // Guards the TOG-45 change end to end: before it, a clean checkout printed
  // three WAITING lines and exited 3 - "nothing you can do". The database is
  // no longer one of them.
  const checks = stagingEnvChecks({});
  assert.equal(verdict(checks), 'fix');
  assert.equal(checks.filter((c) => c.status === 'blocked').length, 2);
  assert.equal(checks.find((c) => c.id === 'database')!.status, 'fix');
});

// --- what the doctor says once it can open the database ---------------------
//
// The decisions live in readiness.ts and are exercised here against real counts
// from a seeded Postgres schema, so that a fixture change moves this test too.

async function realCounts() {
  const harness = await openTestDb(`${import.meta.filename}_readiness`);
  try {
    await seedFixtures(harness.db, { guildId: '999000111222333444', now: TEST_NOW });
    const store = new EventStore(harness.db);
    const counts: Record<string, number> = {};
    for (const type of Object.keys(EXPECTED_FUNNEL)) {
      counts[type] = await store.countByType(type as EventType);
    }
    return counts;
  } finally {
    await harness.cleanup();
  }
}

test('a seeded staging database reads as ready', async () => {
  const checks = databaseStateChecks({
    pendingMigrations: 0,
    appliedMigrations: 4,
    counts: await realCounts(),
  });
  assert.deepEqual(
    checks.map((c) => `${c.title}:${c.status}`),
    ['schema:ok', 'fixtures:ok'],
  );
  assert.equal(verdict(checks), 'ready');
});

test('an unmigrated database says so, and does not go on to count events', () => {
  const checks = databaseStateChecks({ pendingMigrations: 2, appliedMigrations: 0 });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'fix');
  // The mapping onto the live variable name is the trap; the command must show it.
  assert.match(checks[0].action ?? '', /TWO_DATABASE_URL="\$TWO_STAGING_DATABASE_URL"/);
});

test('an empty database is told to seed, not told its counts are wrong', () => {
  const empty = Object.fromEntries(Object.keys(EXPECTED_FUNNEL).map((t) => [t, 0]));
  const checks = databaseStateChecks({ pendingMigrations: 0, appliedMigrations: 4, counts: empty });
  const fixtures = checks.find((c) => c.title === 'fixtures')!;
  assert.equal(fixtures.status, 'fix');
  assert.match(fixtures.detail, /never been seeded/);
});

test('state left behind by a previous suite is reported per event type', async () => {
  const counts = { ...(await realCounts()), first_message: 99 };
  const fixtures = databaseStateChecks({ pendingMigrations: 0, appliedMigrations: 4, counts }).find(
    (c) => c.title === 'fixtures',
  )!;
  assert.equal(fixtures.status, 'fix');
  assert.match(fixtures.detail, /first_message 99\/7/);
  assert.match(fixtures.action ?? '', /staging-reset/);
});

test('every blocked check names an owner', () => {
  const envs: Env[] = [
    {},
    { ...GOOD, DISCORD_STAGING_BOT_TOKEN: LIVE_TOKEN },
    { ...GOOD, DISCORD_STAGING_BOT_TOKEN: undefined, DISCORD_STAGING_GUILD_ID: undefined },
    { ...GOOD, TWO_STAGING_DATABASE_URL: undefined },
  ];
  for (const env of envs) {
    for (const c of stagingEnvChecks(env)) {
      if (c.status === 'blocked') assert.ok(c.owner, `${c.id} is blocked with no owner`);
      if (c.status !== 'ok') assert.ok(c.action, `${c.id} is ${c.status} with no next step`);
    }
  }
});

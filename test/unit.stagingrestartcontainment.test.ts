/**
 * Fail-closed actual-staging restart containment (TOG-3903).
 *
 * No network, no database, no token: every case exercises the pure
 * preflight/fixture-allowlist seam in `src/staging/restartContainment.ts`
 * plus the real-boot refusal ordering (containment refusal fires before
 * `datastore_open`). The contained three-lifecycle local process proof is in
 * `test/e2e.stagingrestart.test.ts`; the normal-path harness remains in
 * `test/e2e.rotaprocess.test.ts`. These checks do not authorize staging execution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import {
  checkStagingRestartPreflight,
  parseSyntheticStagingActorIds,
  stagingRestartContainmentArmed,
  StagingRestartFunnelFirewall,
  type StagingRestartPreflightControls,
} from '../src/staging/restartContainment.ts';
import {
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';
import { registerHandlers } from '../src/discord/client.ts';
import type { FunnelHandlers } from '../src/core/handlers.ts';
import type { InviteTracker } from '../src/core/inviteTracker.ts';

const tokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.Gxxxxx.yyyyyyyyyy`;
const STAGING = TWO_STAGING_GUILD_ID;
const LIVE = LIVE_GUILD_ID;
const LOOPBACK_DB = 'postgres://two@127.0.0.1:55432/two_staging_test';
const STAGING_DB = 'postgres://two@127.0.0.1:5432/two_bot_staging';

function controls(over: Partial<StagingRestartPreflightControls> = {}): StagingRestartPreflightControls {
  return {
    discordToken: tokenFor(STAGING_BOT_APPLICATION_ID),
    databaseUrl: LOOPBACK_DB,
    stagingDatabaseUrl: STAGING_DB,
    guildId: STAGING,
    ...over,
  };
}

function env(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TWO_STAGING_RESTART_CONTAINMENT: '1', ...over };
}

test('absent opt-in is inert: refusal names the flag, never a secret', () => {
  const r = checkStagingRestartPreflight({}, controls());
  assert.equal(r.ok, false);
  assert.match(r.reason!, /TWO_STAGING_RESTART_CONTAINMENT is not '1'/);
  assert.doesNotMatch(r.reason!, new RegExp(STAGING_BOT_APPLICATION_ID.slice(0, 8)));
});

test('malformed flag values are inert, including truthy lookalikes', () => {
  for (const flag of ['true', 'yes', '0', '', '2']) {
    const r = checkStagingRestartPreflight(
      { TWO_STAGING_RESTART_CONTAINMENT: flag },
      controls(),
    );
    assert.equal(r.ok, false, `flag=${JSON.stringify(flag)}`);
  }
});

test('production guild is refused before any network or datastore effect', () => {
  const r = checkStagingRestartPreflight(env(), controls({ guildId: LIVE }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /TWO Staging guild/);
});

test('guild/binding mismatch is refused', () => {
  const r = checkStagingRestartPreflight(env(), controls({ guildId: '900000000000007000' }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /Refusing to continue/);
});

test('live bot token is refused and named', () => {
  const r = checkStagingRestartPreflight(env(), controls({ discordToken: tokenFor(LIVE_BOT_APPLICATION_ID) }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, new RegExp(STAGING_BOT_APPLICATION_ID));
  assert.match(r.reason!, /Nothing was contacted/);
});

test('unknown or unparseable token is refused before Discord', () => {
  const unknown = checkStagingRestartPreflight(env(), controls({ discordToken: tokenFor('123456789012345678') }));
  assert.equal(unknown.ok, false);
  const garbage = checkStagingRestartPreflight(env(), controls({ discordToken: 'garbage' }));
  assert.equal(garbage.ok, false);
});

test('missing staging database binding is refused', () => {
  const r = checkStagingRestartPreflight(env(), controls({ stagingDatabaseUrl: '' }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /TWO_STAGING_DATABASE_URL/);
});

test('non-loopback, option-injected, or wrongly-named databases are refused', () => {
  const host = checkStagingRestartPreflight(
    env(), controls({ databaseUrl: 'postgres://two@db.internal:5432/two_staging' }));
  assert.equal(host.ok, false);
  assert.match(host.reason!, /loopback/);
  const noPort = checkStagingRestartPreflight(
    env(), controls({ databaseUrl: 'postgres://two@127.0.0.1/two_staging' }));
  assert.equal(noPort.ok, false);
  const injected = checkStagingRestartPreflight(
    env(), controls({ databaseUrl: 'postgres://two@127.0.0.1:55432/two_staging?sslmode=require' }));
  assert.equal(injected.ok, false);
  assert.match(injected.reason!, /injection/);
  const wrongName = checkStagingRestartPreflight(
    env(), controls({ databaseUrl: 'postgres://two@127.0.0.1:55432/two_production' }));
  assert.equal(wrongName.ok, false);
  assert.match(wrongName.reason!, /staging\/test/);
});

test('a database target matching the staging binding is refused', () => {
  const r = checkStagingRestartPreflight(env(), controls({
    databaseUrl: 'postgres://other@127.0.0.1:5432/two_bot_staging',
  }));
  assert.equal(r.ok, false);
  assert.match(r.reason!, /matching TWO_STAGING_DATABASE_URL/);
});

test('a fully-bound staging preflight passes', () => {
  const r = checkStagingRestartPreflight(env(), controls());
  assert.equal(r.ok, true);
});

test('armed() uses effective credentials, never a conflicting plain env token', () => {
  assert.equal(stagingRestartContainmentArmed({}, controls()), false);
  assert.equal(stagingRestartContainmentArmed(env(), controls({ discordToken: '' })), false);
  assert.equal(stagingRestartContainmentArmed(env(), controls()), true);
  assert.equal(stagingRestartContainmentArmed(env({
    DISCORD_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID),
  }), controls({ discordToken: tokenFor(LIVE_BOT_APPLICATION_ID) })), false);
  assert.equal(stagingRestartContainmentArmed(env({
    DISCORD_BOT_TOKEN: tokenFor(LIVE_BOT_APPLICATION_ID),
  }), controls()), true);
});

test('synthetic actor allowlist: empty is a closed firewall, malformed is a hard error', () => {
  assert.equal(parseSyntheticStagingActorIds(undefined).size, 0);
  assert.equal(parseSyntheticStagingActorIds('').size, 0);
  assert.equal(parseSyntheticStagingActorIds('900000000000007001').size, 1);
  assert.throws(() => parseSyntheticStagingActorIds('bad'), /Discord user ids/);
  assert.throws(() => parseSyntheticStagingActorIds('900000000000007001,900000000000007001'), /Discord user ids/);
});

test('funnel firewall drops real-member writes and passes synthetic actors', async () => {
  const { EventStore } = await import('../src/store/eventStore.ts');
  void EventStore;
  // Drive the real firewall against a recording EventStore stand-in: the
  // firewall extends FunnelHandlers, so a dropped member must produce no
  // store call at all — not a filtered row.
  const records: Array<{ memberId: string | null; eventType: string }> = [];
  const fakeStore = {
    record: async (e: { memberId: string | null; eventType: string }) => {
      records.push({ memberId: e.memberId, eventType: e.eventType });
      return { inserted: true };
    },
    touchActivity: async () => {},
    hasEvent: async () => false,
    nextMessageRung: async () => null,
  };
  const firewall = new StagingRestartFunnelFirewall(
    fakeStore as never, null, null, new Set(['900000000000007001']),
  );
  const SYN = '900000000000007001';
  const REAL = '900000000000009999';
  await firewall.onJoin({ guildId: STAGING, memberId: REAL, isBot: false, source: 'gateway' });
  await firewall.onGateCleared({ guildId: STAGING, memberId: REAL, isBot: false });
  await firewall.onMessage({ guildId: STAGING, memberId: REAL, isBot: false, channelId: 'c' });
  await firewall.onVoiceJoin({ guildId: STAGING, memberId: REAL, isBot: false, channelId: 'c' });
  await firewall.onVoiceLeave({ guildId: STAGING, memberId: REAL, isBot: false, channelId: 'c' });
  assert.equal(records.length, 0, 'real-member gateway writes never reach the store');
  await firewall.onJoin({ guildId: STAGING, memberId: SYN, isBot: false, source: 'gateway' });
  await firewall.onGateCleared({ guildId: STAGING, memberId: SYN, isBot: false });
  assert.equal(records.length, 2, 'synthetic staging actors pass through');
  assert.deepEqual(records.map((r) => r.memberId), [SYN, SYN]);
});

test('contained audit drops memberless events and real-member leaves before consumers', async () => {
  const seen: string[] = [];
  const leaves: string[] = [];
  const bus = new EventEmitter();
  registerHandlers(bus as unknown as Client, {
    handlers: { onLeave: async (_guild: string, member: string) => { leaves.push(member); return {}; } } as unknown as FunnelHandlers,
    invites: {} as unknown as InviteTracker,
    audit: {
      record: async (event: { entryId: string }) => { seen.push(event.entryId); return true; },
      retryPending: async () => 0,
    },
    stagingRestart: { guildId: STAGING, syntheticActorIds: new Set(['900000000000007001']) },
  });
  bus.emit(Events.Raw, { op: 0, t: 'MESSAGE_DELETE', s: 1, d: { guild_id: STAGING, channel_id: 'c', id: 'm1' } }, 0);
  bus.emit(Events.GuildMemberRemove, { guild: { id: STAGING }, id: '900000000000009999' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, [], 'unknown actor cannot certify safe audit metadata');
  assert.deepEqual(leaves, [], 'real-member leave never reaches the funnel');
  bus.emit(Events.GuildMemberRemove, { guild: { id: STAGING }, id: '900000000000007001' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(leaves, ['900000000000007001'], 'synthetic positive control exercises the same listener');
});

const ROOT = resolve(import.meta.dirname, '..');

test('real boot with the flag set but production guild refuses before datastore_open', () => {
  // The containment gate is fail-closed by construction: a production guild
  // can never satisfy the preflight, so the process must refuse. Legacy mode
  // keeps the session-channel guard from firing first; the assertion is that
  // the refusal names the staging-guild binding and no datastore opens.
  const result = spawnSync(process.execPath, ['src/index.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000,
    // Env excludes the ambient shell's real staging bindings (which would
    // otherwise satisfy the token read through the credential path) while
    // keeping a working PATH for the node binary.
    env: {
      PATH: process.env.PATH,
      DISCORD_STAGING_BOT_TOKEN: '',
      DISCORD_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID),
      TWO_DATABASE_URL: 'postgres://two@127.0.0.1:1/two_staging_test',
      TWO_STAGING_DATABASE_URL: STAGING_DB,
      DISCORD_GUILD_ID: LIVE,
      DISCORD_STAGING_GUILD_ID: STAGING,
      TWO_STAGING_RESTART_CONTAINMENT: '1',
      TWO_ONBOARDING_MODE: 'legacy',
    },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.match(output, /TWO Staging guild|staging_restart_containment/i);
  assert.doesNotMatch(output, /datastore_open/);
});

test('real boot with the flag set and live token refuses before datastore_open', () => {
  const result = spawnSync(process.execPath, ['src/index.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000,
    // Env excludes the ambient shell's real staging bot token (which would
    // otherwise satisfy the token read through the credential path).
    env: {
      PATH: process.env.PATH,
      DISCORD_STAGING_BOT_TOKEN: '',
      DISCORD_BOT_TOKEN: tokenFor(LIVE_BOT_APPLICATION_ID),
      TWO_DATABASE_URL: 'postgres://two@127.0.0.1:1/two_staging_test',
      TWO_STAGING_DATABASE_URL: STAGING_DB,
      DISCORD_GUILD_ID: STAGING,
      DISCORD_STAGING_GUILD_ID: STAGING,
      TWO_STAGING_RESTART_CONTAINMENT: '1',
      TWO_ONBOARDING_MODE: 'legacy',
    },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  // Fail-closed: the live token can never satisfy the staging-token check,
  // so boot must refuse before the datastore opens. The refusal names both
  // application ids (staging expected, live received) so the operator can see
  // the wrong-application mix-up; it never prints the token itself.
  assert.match(output, /staging bot|Nothing was contacted|staging_restart_containment/i);
  assert.doesNotMatch(output, /datastore_open/);
  assert.doesNotMatch(output, /Gxxxxx|yyyyyyyyyy/);
});

test('real boot refuses unsafe credential files even when plain env looks safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-restart-credentials-'));
  try {
    for (const fixture of [
      { token: tokenFor(LIVE_BOT_APPLICATION_ID), database: LOOPBACK_DB, reason: /staging bot token/ },
      { token: tokenFor(STAGING_BOT_APPLICATION_ID), database: 'postgres://two@db.invalid:5432/two_staging', reason: /loopback database/ },
    ]) {
      writeFileSync(join(dir, 'discord_token'), fixture.token, { mode: 0o600 });
      writeFileSync(join(dir, 'database_url'), fixture.database, { mode: 0o600 });
      const result = spawnSync(process.execPath, ['src/index.ts'], {
        cwd: ROOT, encoding: 'utf8', timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          CREDENTIALS_DIRECTORY: dir,
          DISCORD_BOT_TOKEN: tokenFor(STAGING_BOT_APPLICATION_ID),
          TWO_DATABASE_URL: LOOPBACK_DB,
          TWO_STAGING_DATABASE_URL: STAGING_DB,
          DISCORD_GUILD_ID: STAGING,
          TWO_STAGING_RESTART_CONTAINMENT: '1',
          TWO_ONBOARDING_MODE: 'legacy',
        },
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, fixture.reason);
      assert.doesNotMatch(output, /datastore_open|Gxxxxx|yyyyyyyyyy|db\.invalid/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real boot without the flag preserves normal production behavior', () => {
  const result = spawnSync(process.execPath, ['src/index.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      DISCORD_STAGING_BOT_TOKEN: '',
      DISCORD_BOT_TOKEN: 'fixture-token',
      TWO_DATABASE_URL: 'postgres://two@127.0.0.1:1/unused',
      DISCORD_GUILD_ID: '111111111111111111',
      DISCORD_STAGING_GUILD_ID: '111111111111111111',
      TWO_ONBOARDING_ROTA_MEASUREMENT: '1',
      TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: 'fixture-only-boot-key-not-a-real-secret',
      TWO_ONBOARDING_MODE: 'session',
    },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /staging_restart_containment_armed/);
  assert.match(output, /session requires DISCORD_GUILD_ID/);
});

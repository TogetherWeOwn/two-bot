/**
 * Post-deploy staging smoke: health plus the onboarding funnel, mock-safe (TOG-8316).
 *
 *   TWO_SMOKE_DATABASE_URL=postgres://... node scripts/staging-smoke.ts [--timeout-ms 120000]
 *
 * Boots the REAL bot process (unmodified src/index.ts) against the mock-Discord
 * harness (tools/mock-discord/), then runs two slices in one boot:
 *
 *   HEALTH (the deploy gate: is the new build alive?)
 *   - the process stays up (no boot crash on the merged code)
 *   - GET /healthz answers 200 `ok`
 *   - a `{"msg":"ready","user":"...","guilds":N}` line appears with N >= 1
 *   - GET /readyz answers 200 `ok` (gateway connected, database answered)
 *
 *   FUNNEL (the product gate: does the merged code still onboard?)
 *   - member joins behind the rules gate -> `member_join` recorded, no
 *     `gate_cleared` yet (the gate event is its own funnel step, TOG-76)
 *   - member accepts the rules -> `gate_cleared` recorded with source
 *     `gateway`, `members.gate_cleared_at` set
 *   - welcome posted in the landing channel mentioning the member
 *   - member picks a game -> `channel_routed` recorded AND the game role
 *     actually granted through the mock Discord REST
 *   - member sends messages -> `first_message` recorded
 *
 * Sibling coverage, named so this script is not mistaken for it:
 * - scripts/health-check.ts proves the RUNBOOK "Is it alive?" shape (JSONL
 *   logs, health-before-ready ordering, SIGTERM release). This script does
 *   not repeat those; it proves the deploy is alive AND onboarding.
 * - scripts/staging-verify.ts proves the REAL staging guild (roles, panels,
 *   audit parity) with real credentials. This script proves the merged CODE
 *   with no credentials at all.
 * - test/e2e.*.test.ts proves the same flows as a CI suite. This script is
 *   the operator's single command after a deploy: one boot, pass/fail per
 *   check, nonzero exit on failure.
 *
 * Repo-local only: mock token, mock gateway, loopback health port. Nothing
 * reaches Discord, no credentials, no production activation. The database it
 * writes to is chosen by TWO_SMOKE_DATABASE_URL and must look like a
 * throwaway: the database name has to contain `smoke`, `test` or `staging`,
 * and the script uses an isolated schema it drops on the way out.
 *
 * Exit codes: 0 every check passed, 1 a check failed,
 * 2 usage or environment error (matches the staging-verify shape).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startMockDiscord, type MockDiscord } from '../tools/mock-discord/server.ts';
import { openDb, type Db } from '../src/store/db.ts';
import { pickByKey } from '../src/onboarding/catalog.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

export type SmokeStatus = 'pass' | 'fail';

export interface SmokeCheck {
  id: string;
  status: SmokeStatus;
  detail: string;
}

export interface StagingSmokeReport {
  checks: SmokeCheck[];
  passed: boolean;
}

export interface RunStagingSmokeOptions {
  /** Throwaway Postgres URL. Never logged; name must contain smoke/test/staging. */
  databaseUrl: string;
  /** Total budget for boot + probes + funnel drive, ms. Default 120_000. */
  timeoutMs?: number;
}

/** The script's private schema. Dropped on the way out, success or failure. */
const SMOKE_SCHEMA = 'smoke_deploy';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until `fn` resolves truthy. Callers signal "not yet" with null; the
 * only way out is a truthy value or the deadline.
 */
async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = 'not yet observed';
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err; // bot not up / tables not migrated yet
    }
    await sleep(200);
  }
  throw new Error(`timed out; last: ${String(last)}`);
}

interface BotLogLine {
  raw: string;
  json: Record<string, unknown> | null;
}

function parseLine(raw: string): BotLogLine {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return { raw, json: json && typeof json === 'object' ? json : null };
  } catch {
    return { raw, json: null };
  }
}

/**
 * Refuse anything that does not look like a throwaway database. The bot opens
 * the URL it is given with migrations; pointing this script at the live
 * staging database would write funnel rows into evidence QA reads.
 */
export function assertThrowawayDatabaseUrl(url: string): void {
  let name = '';
  try {
    name = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  } catch {
    throw new Error('TWO_SMOKE_DATABASE_URL is not a valid URL.');
  }
  if (!/smoke|test|staging/i.test(name)) {
    throw new Error(
      `refusing database "${name}": TWO_SMOKE_DATABASE_URL must point at a throwaway ` +
        `(name contains smoke, test or staging).`,
    );
  }
}

export async function runStagingSmoke(opts: RunStagingSmokeOptions): Promise<StagingSmokeReport> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const checks: SmokeCheck[] = [];
  const pass = (id: string, detail: string) => checks.push({ id, status: 'pass', detail });
  const fail = (id: string, detail: string) => checks.push({ id, status: 'fail', detail });

  let mock: MockDiscord | null = null;
  let bot: ChildProcess | null = null;
  let reader: Db | null = null;
  let exited: number | null = null;
  const lines: BotLogLine[] = [];
  let pending = '';
  const onData = (d: unknown) => {
    pending += String(d);
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const raw of parts) {
      if (raw.trim() === '') continue;
      lines.push(parseLine(raw));
    }
  };
  const logTail = (n = 20) => lines.map((l) => l.raw).slice(-n).join('\n');

  try {
    assertThrowawayDatabaseUrl(opts.databaseUrl);

    // Fresh schema per run: a previous red run's rows must not green this one.
    // The runner needs CREATE on this database (to own one isolated schema);
    // a role without it fails here as a FAIL check, not an uncaught error.
    // Staging's own tables are never touched - only the smoke_deploy schema.
    const setupError: unknown = await openDb(opts.databaseUrl, { skipMigrations: true })
      .then(async (bootstrap) => {
        try {
          await bootstrap.exec(`DROP SCHEMA IF EXISTS ${SMOKE_SCHEMA} CASCADE`);
          // The bot child migrates through PGOPTIONS search_path alone, which
          // does not create the schema - it must exist before the bot boots.
          await bootstrap.exec(`CREATE SCHEMA ${SMOKE_SCHEMA}`);
        } finally {
          await bootstrap.close();
        }
        return null;
      })
      .catch((err: unknown) => err);
    if (setupError) {
      fail('smoke-database-reachable', `cannot prepare the smoke schema: ${String(setupError)}`);
      return { checks, passed: false };
    }
    pass('smoke-database-reachable', 'throwaway database opened, fresh smoke schema created');

    mock = await startMockDiscord().catch((err: unknown) => {
      fail('mock-discord-up', `mock Discord harness failed to start: ${String(err)}`);
      return null;
    });
    if (!mock) return { checks, passed: false };
    const activeMock = mock;
    pass('mock-discord-up', `harness listening on ${activeMock.apiBase}`);

    // Hold the health port bound until the child exists, so a sibling on a
    // shared runner cannot slip into a bind-release gap (same race
    // health-check.ts documents).
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', () => r()));
    const port = (holder.address() as AddressInfo).port;
    const url = (p: string) => `http://127.0.0.1:${port}${p}`;

    // Hermetic child env: ambient real credentials must not leak into the
    // "mock-safe" boot. requiredToken() prefers DISCORD_BOT_TOKEN over
    // DISCORD_TOKEN, and systemd credential files win over both (hence the
    // CREDENTIALS_DIRECTORY scrub, same as e2e.stagingverify.test.ts); staging
    // restart containment re-arms from ambient TWO_STAGING_* alone.
    const botEnv: Record<string, string | undefined> = {
      ...process.env,
      DISCORD_TOKEN: 'mock.token.value',
      DISCORD_BOT_TOKEN: 'mock.token.value',
      CREDENTIALS_DIRECTORY: '',
      DISCORD_API_BASE: activeMock.apiBase,
      DISCORD_GUILD_ID: activeMock.guildId,
      DISCORD_LANDING_CHANNEL_IDS: activeMock.textChannelId,
      TWO_DATABASE_URL: opts.databaseUrl,
      PGOPTIONS: `-c search_path=${SMOKE_SCHEMA}`,
      TWO_HEALTH_PORT: String(port),
      TWO_HEALTH_BIND_HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
    };
    delete botEnv.TWO_STAGING_DATABASE_URL;
    delete botEnv.TWO_STAGING_RESTART_CONTAINMENT;
    delete botEnv.TWO_STAGING_RESTART_SYNTHETIC_ACTORS;

    bot = spawn(process.execPath, ['src/index.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: botEnv,
    });
    await new Promise<void>((r) => holder.close(() => r()));
    const child = bot;
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      exited = code;
    });

    // --- HEALTH ------------------------------------------------------------
    await sleep(1500);
    if (exited !== null) {
      fail('bot-process-stays-up', `bot exited with ${exited} shortly after start\n${logTail()}`);
      return { checks, passed: false };
    }
    pass('bot-process-stays-up', 'still running after boot');

    const live = await waitFor(async () => {
      const res = await fetch(url('/healthz'));
      return res.ok ? res : null;
    }, Math.min(timeoutMs, 30_000)).catch(() => null);
    if (!live) {
      fail('liveness-200-ok', `GET /healthz never answered 200\n${logTail()}`);
      return { checks, passed: false };
    }
    pass('liveness-200-ok', 'GET /healthz -> 200 ok');

    await activeMock.waitForReady(Math.min(timeoutMs, 30_000)).catch((err: unknown) => {
      fail('gateway-ready', `mock gateway never saw IDENTIFY: ${String(err)}\n${logTail()}`);
    });
    if (checks.some((c) => c.status === 'fail')) return { checks, passed: false };
    pass('gateway-ready', 'mock gateway completed IDENTIFY and sent READY');

    const readyLine = await waitFor(async () => {
      const found = lines.find((l) => l.json?.msg === 'ready');
      return found ?? null;
    }, timeoutMs).catch((e: unknown) => {
      fail('ready-line', `no {"msg":"ready"} line appeared: ${String(e)}\n${logTail()}`);
      return null;
    });
    if (readyLine?.json) {
      const user = readyLine.json.user;
      const guilds = readyLine.json.guilds;
      if (typeof user === 'string' && user.length > 0 && typeof guilds === 'number' && guilds >= 1) {
        pass('ready-line', `{"msg":"ready","user":"${user}","guilds":${guilds}}`);
      } else {
        fail('ready-line', `ready line has the wrong shape: ${readyLine.raw}`);
      }
    }
    if (checks.some((c) => c.status === 'fail')) return { checks, passed: false };

    const ready = await waitFor(async () => {
      const res = await fetch(url('/readyz'));
      return res.status === 200 ? res : null;
    }, timeoutMs).catch((e: unknown) => {
      fail('readiness-200-ok', `GET /readyz never answered 200: ${String(e)}\n${logTail()}`);
      return null;
    });
    if (ready) {
      const body = (await ready.text()).trim();
      if (body === 'ok') pass('readiness-200-ok', 'GET /readyz -> 200 ok (gateway connected, database answered)');
      else fail('readiness-200-ok', `GET /readyz -> 200 with unexpected body ${body}`);
    }
    if (checks.some((c) => c.status === 'fail')) return { checks, passed: false };

    // A reader on the same schema the bot migrated, so funnel assertions read
    // what the bot actually wrote.
    reader = await openDb(opts.databaseUrl, {
      schema: SMOKE_SCHEMA,
      skipMigrations: true,
      applicationName: 'two-bot-staging-smoke',
    }).catch((err: unknown) => {
      fail('smoke-schema-readable', `cannot open smoke schema for assertions: ${String(err)}`);
      return null;
    });
    if (!reader) return { checks, passed: false };
    const db = reader;

    // --- FUNNEL ------------------------------------------------------------
    const MEMBER = '900000000000008881';
    const queryDb = async <T>(fn: (db: Db) => Promise<T>): Promise<T | null> => {
      try {
        return await fn(db);
      } catch {
        return null; // tables not migrated yet
      }
    };
    const funnelFail = (id: string, what: string) => fail(id, `${what}\n--- bot output ---\n${logTail()}`);

    // 1. Joins behind the rules gate: join on file, clearing not.
    activeMock.memberJoinPending(MEMBER, 'smoke-newbie');
    try {
      await waitFor(async () => {
        try {
          const row = await db
            .prepare(`SELECT 1 AS x FROM events WHERE event_type='member_join' AND member_id=?`)
            .get(MEMBER);
          return row ? true : null;
        } catch {
          return null; // tables not migrated yet
        }
      }, timeoutMs);
      pass('funnel-member-join', 'member_join recorded for a pending member');
    } catch (e) {
      funnelFail('funnel-member-join', `member_join never recorded: ${String(e)}`);
      return { checks, passed: false };
    }
    await sleep(800);
    const earlyGate = (await queryDb((d) =>
      d.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='gate_cleared' AND member_id=?`).get<{ n: number }>(MEMBER),
    )) as { n: number } | null;
    if (Number(earlyGate?.n ?? 0) !== 0) {
      funnelFail('funnel-gate-holds', 'gate_cleared recorded for a member still behind the rules gate');
      return { checks, passed: false };
    }
    pass('funnel-gate-holds', 'no gate_cleared while the member is pending');

    // 2. Rules accepted: the clearing lands as a real measurement, projected.
    activeMock.memberAcceptRules(MEMBER, 'smoke-newbie');
    try {
      const gate = await waitFor(async () => {
        const row = (await queryDb((d) =>
          d.prepare(`SELECT source FROM events WHERE event_type='gate_cleared' AND member_id=?`).get<{ source: string }>(MEMBER),
        )) as { source: string } | null;
        return row ? row : null;
      }, timeoutMs);
      if (gate.source !== 'gateway') {
        funnelFail('funnel-gate-cleared', `gate_cleared source is "${gate.source}", expected "gateway"`);
        return { checks, passed: false };
      }
      pass('funnel-gate-cleared', 'gate_cleared recorded with source gateway');
    } catch (e) {
      funnelFail('funnel-gate-cleared', `gate_cleared never recorded: ${String(e)}`);
      return { checks, passed: false };
    }
    const projected = (await queryDb((d) =>
      d.prepare(`SELECT gate_cleared_at AS t FROM members WHERE member_id=?`).get<{ t: string | null }>(MEMBER),
    )) as { t: string | null } | null;
    if (!projected?.t) {
      funnelFail('funnel-gate-projected', 'members.gate_cleared_at is not set');
      return { checks, passed: false };
    }
    pass('funnel-gate-projected', 'members.gate_cleared_at set');

    // 3. The welcome lands in the landing channel, mentioning them.
    const posted = () =>
      activeMock.captured
        .map((c) => ({ m: /\/api\/v10\/channels\/(\d+)\/messages$/.exec(c.url), c }))
        .filter(({ m, c }) => m && c.method === 'POST')
        .map(({ m, c }) => ({
          channelId: m![1] as string,
          content: (c.body as { content?: string })?.content ?? '',
        }));
    try {
      const welcome = await waitFor(async () => {
        const found = posted().find((p) => p.channelId === activeMock.textChannelId);
        return found ?? null;
      }, timeoutMs);
      if (!new RegExp(`<@${MEMBER}>`).test(welcome.content)) {
        funnelFail('funnel-welcome', 'welcome post does not mention the member');
        return { checks, passed: false };
      }
      pass('funnel-welcome', `welcome posted in the landing channel mentioning <@${MEMBER}>`);
    } catch (e) {
      funnelFail('funnel-welcome', `no welcome post in the landing channel: ${String(e)}`);
      return { checks, passed: false };
    }

    // 4. They pick a game: routed AND the role actually granted. The grant -
    //    not just the row - is the check that catches a hierarchy regression.
    const shooters = pickByKey('shooters');
    if (!shooters) {
      funnelFail('funnel-game-routed', 'catalog has no shooters pick to drive');
      return { checks, passed: false };
    }
    activeMock.selectGames(MEMBER, 'smoke-newbie', ['shooters']);
    try {
      await waitFor(async () => {
        try {
          const row = await db
            .prepare(`SELECT 1 AS x FROM events WHERE event_type='channel_routed' AND member_id=?`)
            .get(MEMBER);
          return row ? true : null;
        } catch {
          return null;
        }
      }, timeoutMs);
      pass('funnel-game-routed', 'channel_routed recorded after the game pick');
    } catch (e) {
      funnelFail('funnel-game-routed', `channel_routed never recorded: ${String(e)}`);
      return { checks, passed: false };
    }
    const roleWrites = activeMock.captured.filter(
      (c) => /\/guilds\/\d+\/members\/\d+/.test(c.url) && c.method !== 'GET',
    );
    const granted = roleWrites.some(
      (c) =>
        c.url.endsWith(`/roles/${shooters.roleId}`) ||
        (Array.isArray((c.body as { roles?: string[] })?.roles) &&
          (c.body as { roles: string[] }).roles.includes(shooters.roleId)),
    );
    if (!granted) {
      funnelFail('funnel-role-granted', `Shooter Games (${shooters.roleId}) was never granted`);
      return { checks, passed: false };
    }
    pass('funnel-role-granted', `Shooter Games role granted through the mock REST`);

    // 5. They talk: the message ladder starts.
    activeMock.message(MEMBER);
    try {
      await waitFor(async () => {
        try {
          const row = await db
            .prepare(`SELECT 1 AS x FROM events WHERE event_type='first_message' AND member_id=?`)
            .get(MEMBER);
          return row ? true : null;
        } catch {
          return null;
        }
      }, timeoutMs);
      pass('funnel-first-message', 'first_message recorded');
    } catch (e) {
      funnelFail('funnel-first-message', `first_message never recorded: ${String(e)}`);
      return { checks, passed: false };
    }

    return { checks, passed: checks.every((c) => c.status !== 'fail') };
  } finally {
    if (bot && bot.exitCode === null) bot.kill('SIGKILL');
    await mock?.close().catch(() => {});
    await reader?.close().catch(() => {});
    // Never leave rows behind for the next run to trip over.
    if (opts.databaseUrl) {
      await openDb(opts.databaseUrl, { skipMigrations: true })
        .then(async (cleanup) => {
          try {
            await cleanup.exec(`DROP SCHEMA IF EXISTS ${SMOKE_SCHEMA} CASCADE`);
          } finally {
            await cleanup.close();
          }
        })
        .catch(() => {});
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes('--help')) {
    console.log('usage: node scripts/staging-smoke.ts [--timeout-ms <n>]');
    console.log('');
    console.log('Post-deploy staging smoke: health plus the onboarding funnel, mock-safe.');
    console.log('');
    console.log('Flags:');
    console.log('  --timeout-ms <n>  Per-check timeout in ms (default 120000).');
    console.log('  --help            Show this help and exit.');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/staging-smoke.ts --help');
    console.log('  TWO_SMOKE_DATABASE_URL=postgres://two:two@localhost:5432/twobot_smoke \\');
    console.log('    node scripts/staging-smoke.ts');
    console.log('');
    console.log('Requires TWO_SMOKE_DATABASE_URL pointing at a throwaway Postgres database; --help needs none.');
    process.exit(0);
  }
  const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-ms='))?.slice('--timeout-ms='.length);
  const timeoutMs = timeoutArg !== undefined ? Number(timeoutArg) : 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error('staging-smoke: --timeout-ms must be a positive number of milliseconds.');
    process.exit(2);
  }
  const databaseUrl = process.env.TWO_SMOKE_DATABASE_URL?.trim() ?? '';
  if (!databaseUrl) {
    console.error(
      'staging-smoke: TWO_SMOKE_DATABASE_URL is not set.\n' +
        '  Point it at a THROWAWAY Postgres database (name contains smoke, test or staging).\n' +
        '  Example: TWO_SMOKE_DATABASE_URL=postgres://two:two@localhost:5432/twobot_smoke \\\n' +
        '    node scripts/staging-smoke.ts',
    );
    process.exit(2);
  }

  let report: StagingSmokeReport;
  try {
    assertThrowawayDatabaseUrl(databaseUrl);
  } catch (err) {
    console.error(`staging-smoke: ${String(err)}`);
    process.exit(2);
  }
  try {
    report = await runStagingSmoke({ databaseUrl, timeoutMs });
  } catch (err) {
    console.error(`staging-smoke: unexpected error: ${String(err)}`);
    process.exit(1);
  }
  console.log('\nTWO staging smoke (mock transport)\n');
  for (const c of report.checks) {
    console.log(`  ${c.status.toUpperCase().padEnd(4)}  ${c.id}  ${c.detail.split('\n')[0]}`);
  }
  const counts = (s: SmokeStatus) => report.checks.filter((c) => c.status === s).length;
  console.log(`\nstaging-smoke: ${counts('pass')} pass, ${counts('fail')} fail`);
  console.log(report.passed ? 'STAGING SMOKE PASSED' : 'STAGING SMOKE FAILED');
  process.exit(report.passed ? 0 : 1);
}

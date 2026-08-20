/**
 * "Is staging ready, and if not, whose problem is it?"
 *
 * Every staging script guards its own preconditions and exits 2 on the first
 * one that fails. That is correct for a script and miserable for a person: QA
 * sets one variable, re-runs, hits the next guard, sets another, re-runs. Four
 * round trips to learn that the thing they are actually waiting for is a
 * credential nobody has bound yet.
 *
 * This module answers all of it at once, from the environment alone - no
 * network, no database, no token ever printed - so `scripts/staging-doctor.ts`
 * can say "three of these are fine, this one is waiting on the founder" in a
 * single run. `scripts/staging-reset.ts` consumes the same checks for its own
 * guards, so the refusal a script gives and the diagnosis the doctor gives
 * cannot drift apart.
 *
 * The distinction that matters is the `status`:
 *   ok      - nothing to do.
 *   fix     - the value is present and wrong. Whoever is at the keyboard fixes
 *             it, usually in one command.
 *   blocked - the value is absent or belongs to someone else. Naming an owner
 *             is the whole point; "missing credential" with no owner is how an
 *             issue sits blocked for two cycles.
 */
import { EXPECTED_FUNNEL } from './fixtures.ts';
import {
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  applicationIdFromToken,
} from './spec.ts';

export type CheckStatus = 'ok' | 'fix' | 'blocked';

export type CheckId = 'token' | 'guild' | 'database';

export interface ReadinessCheck {
  id: CheckId;
  /** What the check is called in the doctor's output. */
  title: string;
  status: CheckStatus;
  /** What is true right now. One line, no secrets. */
  detail: string;
  /** Who can make this ok. Required whenever status is `blocked`. */
  owner?: string;
  /** The exact next step - a command, or the ask to put in front of the owner. */
  action?: string;
}

export interface Env {
  DISCORD_STAGING_BOT_TOKEN?: string;
  DISCORD_STAGING_GUILD_ID?: string;
  TWO_STAGING_DATABASE_URL?: string;
  /** The LIVE connection string. Read only so we can refuse to match it. */
  TWO_DATABASE_URL?: string;
}

/**
 * host:port/database, ignoring credentials.
 *
 * Two URLs with different users and the same target are the same database, and
 * seeding ten fake members into it would corrupt every growth number we have.
 * Comparing the strings would miss that; comparing the target does not.
 */
function dbTarget(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return null;
  }
}

function dbName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function tokenCheck(env: Env): ReadinessCheck {
  const token = env.DISCORD_STAGING_BOT_TOKEN?.trim();
  const base = { id: 'token' as const, title: 'staging bot token' };

  if (!token) {
    return {
      ...base,
      status: 'blocked',
      detail: 'DISCORD_STAGING_BOT_TOKEN is not set in this environment.',
      owner: 'founder (TWO-21)',
      action:
        `bind the secret \`discord_staging_bot_token\` (application ${STAGING_BOT_APPLICATION_ID}, ` +
        `${STAGING_BOT_APPLICATION_NAME}) to the engineer and QA agents as DISCORD_STAGING_BOT_TOKEN`,
    };
  }

  const appId = applicationIdFromToken(token);
  if (appId === LIVE_BOT_APPLICATION_ID) {
    return {
      ...base,
      status: 'blocked',
      detail:
        `this token belongs to the LIVE bot (application ${LIVE_BOT_APPLICATION_ID}), not ` +
        `${STAGING_BOT_APPLICATION_NAME} (${STAGING_BOT_APPLICATION_ID}).`,
      owner: 'founder (TWO-21)',
      action:
        'the variable was filled from the wrong application - rebind it. Do not edit it locally, ' +
        'and do not run anything staging with this value loaded',
    };
  }
  if (appId === STAGING_BOT_APPLICATION_ID) {
    return {
      ...base,
      status: 'ok',
      detail: `${STAGING_BOT_APPLICATION_NAME} (${appId}).`,
    };
  }
  if (appId === null) {
    return {
      ...base,
      status: 'ok',
      detail: 'set, but not shaped like a bot token - Discord will judge it, not this check.',
    };
  }
  // Not the live bot, but not the application TWO-21 said it would be either.
  // The earlier version of this check called that 'ok' and printed "Continuing",
  // on the reasoning that anything which is not the live bot is harmless. That
  // is false: "not the live bot" says nothing about which servers the unknown
  // bot is already in, and the first real token we got under this name turned
  // out to be a third application sitting in the live TWO guild. An identity we
  // cannot name is a stop, not a note.
  return {
    ...base,
    status: 'blocked',
    detail:
      `application ${appId} - not the live bot, but not ${STAGING_BOT_APPLICATION_NAME} ` +
      `(${STAGING_BOT_APPLICATION_ID}) either. We cannot say what this bot is or what it can reach.`,
    owner: 'founder (TWO-21)',
    action:
      `confirm which application DISCORD_STAGING_BOT_TOKEN should come from and rebind it, or tell us ` +
      `${appId} is the intended one and we will update STAGING_BOT_APPLICATION_ID. Do not run staging ` +
      'writes against an unidentified bot',
  };
}

function guildCheck(env: Env, tokenOk: boolean): ReadinessCheck {
  const id = env.DISCORD_STAGING_GUILD_ID?.trim();
  const base = { id: 'guild' as const, title: 'staging Discord server' };

  if (id === LIVE_GUILD_ID) {
    return {
      ...base,
      status: 'fix',
      detail: `DISCORD_STAGING_GUILD_ID is the LIVE TWO server (${LIVE_GUILD_ID}).`,
      action: 'unset it. Nothing staging may run against the live guild, ever',
    };
  }
  if (id) {
    return { ...base, status: 'ok', detail: `guild ${id}.` };
  }
  // No id yet. Whether that is a chore or a wait depends entirely on the token,
  // because the bot builds the server itself and cannot do so without one.
  if (!tokenOk) {
    return {
      ...base,
      status: 'blocked',
      detail: 'no staging server exists yet, and it cannot be created without the token above.',
      owner: 'founder (TWO-21), via the token',
      action: 'nothing to do here until the token lands',
    };
  }
  return {
    ...base,
    status: 'fix',
    detail: 'no staging server yet - the bot creates its own.',
    action:
      'node scripts/staging-provision.ts --apply, then put the guild id it prints in ' +
      'DISCORD_STAGING_GUILD_ID (it is not a secret)',
  };
}

function databaseCheck(env: Env): ReadinessCheck {
  const url = env.TWO_STAGING_DATABASE_URL?.trim();
  const base = { id: 'database' as const, title: 'staging database' };

  if (!url) {
    return {
      ...base,
      status: 'blocked',
      detail: 'TWO_STAGING_DATABASE_URL is not set.',
      owner: 'founder (TWO-11 host, then TWO-18 Postgres)',
      action:
        'a second database on whatever Postgres server TWO-18 lands on - no extra spend, ' +
        'but it needs the host first',
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    return {
      ...base,
      status: 'fix',
      detail: 'TWO_STAGING_DATABASE_URL is not a Postgres URL.',
      action: 'staging runs the same engine as live, or it proves nothing. Use postgres://',
    };
  }

  const name = dbName(url);
  if (!/staging|test/i.test(name)) {
    return {
      ...base,
      status: 'fix',
      detail: `database "${name || '(unparseable)'}" is not named like a staging database.`,
      action: 'the name must contain "staging" or "test" - the reset script wipes what it is given',
    };
  }

  // The one that would be unrecoverable. Same target, different credentials,
  // still the live funnel.
  const live = env.TWO_DATABASE_URL?.trim();
  if (live) {
    const a = dbTarget(url);
    const b = dbTarget(live);
    if (a && b && a === b) {
      return {
        ...base,
        status: 'fix',
        detail: `TWO_STAGING_DATABASE_URL points at the same database as TWO_DATABASE_URL (${a}).`,
        action:
          'point staging somewhere else before running anything. A reset against this would ' +
          'delete the live funnel and there is no undo',
      };
    }
  }

  return { ...base, status: 'ok', detail: `${name}.` };
}

/**
 * Every environment-level check, in the order a person would hit them.
 *
 * Pure: same env in, same checks out, no clock and no network. That is what
 * lets `test/unit.staging.test.ts` cover the wrong-token and same-database
 * cases, which are precisely the ones nobody can safely reproduce by hand.
 */
export function stagingEnvChecks(env: Env): ReadinessCheck[] {
  const token = tokenCheck(env);
  return [token, guildCheck(env, token.status === 'ok'), databaseCheck(env)];
}

/**
 * What the database itself says, once we are allowed to open it.
 *
 * Split from the connecting so it can be tested without Postgres: the caller
 * does the IO and hands the numbers in. The counts are whatever
 * `EventStore.countByType` returned, per event type.
 */
export function databaseStateChecks(state: {
  pendingMigrations: number;
  appliedMigrations: number;
  /** Omit when the schema is not there yet - there is nothing to count. */
  counts?: Readonly<Record<string, number>>;
}): ReadinessCheck[] {
  if (state.pendingMigrations > 0) {
    return [
      {
        id: 'database',
        title: 'schema',
        status: 'fix',
        detail: `${state.pendingMigrations} migration(s) not applied to this database.`,
        // migrate.ts reads TWO_DATABASE_URL - the LIVE variable name - because
        // it is a general tool. Mapping it across by hand is the one place a
        // typo points a migration at production, so spell the command out.
        action:
          'TWO_DATABASE_URL="$TWO_STAGING_DATABASE_URL" node scripts/migrate.ts   ' +
          '(note the mapping: migrate.ts only reads the live variable name)',
      },
    ];
  }

  const checks: ReadinessCheck[] = [
    {
      id: 'database',
      title: 'schema',
      status: 'ok',
      detail: `${state.appliedMigrations} migration(s) applied.`,
    },
  ];
  if (!state.counts) return checks;

  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    checks.push({
      id: 'database',
      title: 'fixtures',
      status: 'fix',
      detail: 'no events at all - this database has never been seeded.',
      action: 'node scripts/staging-reset.ts',
    });
    return checks;
  }

  const off = Object.entries(EXPECTED_FUNNEL)
    .filter(([type, expected]) => (state.counts![type] ?? 0) !== expected)
    .map(([type, expected]) => `${type} ${state.counts![type] ?? 0}/${expected}`);

  checks.push(
    off.length
      ? {
          id: 'database',
          title: 'fixtures',
          status: 'fix',
          detail: `${off.length} funnel count(s) off: ${off.join(', ')}.`,
          action: 'node scripts/staging-reset.ts   (a previous suite left state behind)',
        }
      : { id: 'database', title: 'fixtures', status: 'ok', detail: 'the known state.' },
  );
  return checks;
}

export type Verdict = 'ready' | 'fix' | 'blocked';

/**
 * `fix` outranks `blocked`: if something is set wrong AND something else is
 * missing, the wrong value is the one that can bite today.
 */
export function verdict(checks: ReadinessCheck[]): Verdict {
  if (checks.some((c) => c.status === 'fix')) return 'fix';
  if (checks.some((c) => c.status === 'blocked')) return 'blocked';
  return 'ready';
}

/** Exit codes: 0 ready, 1 you have something to fix, 3 waiting on someone. */
export const EXIT_CODE: Readonly<Record<Verdict, number>> = { ready: 0, fix: 1, blocked: 3 };

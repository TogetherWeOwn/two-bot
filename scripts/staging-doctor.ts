/**
 * One command that answers "can I run the integration suite yet?"
 *
 *   node scripts/staging-doctor.ts
 *
 * Run this first, every time. It reads the environment, and - only if the
 * database check passes - opens the staging database read-only to see whether
 * the schema and the fixtures are actually there. It writes nothing, contacts
 * Discord not at all, and never prints a token.
 *
 * Exit codes are the point:
 *   0  ready. Reset and run your suite.
 *   1  something here is wrong and you can fix it. The line says how.
 *   3  waiting on somebody. The line says who. Nothing you can do.
 *
 * A 3 is not a failure of your setup. It is why this script exists: the
 * difference between "I have misconfigured something" and "the founder has not
 * bound the token yet" is twenty minutes of QA's afternoon, and until now the
 * only way to tell was to read four guard messages one refusal at a time.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { EXPECTED_FUNNEL } from '../src/staging/fixtures.ts';
import {
  EXIT_CODE,
  databaseStateChecks,
  stagingEnvChecks,
  verdict,
  type ReadinessCheck,
} from '../src/staging/readiness.ts';
import { loadMigrations, MIGRATIONS_DIR } from '../src/store/migrate.ts';
import type { EventType } from '../src/core/events.ts';

const LABEL: Record<ReadinessCheck['status'], string> = {
  ok: 'ok     ',
  fix: 'FIX    ',
  blocked: 'WAITING',
};

function print(c: ReadinessCheck): void {
  console.log(`  ${LABEL[c.status]} ${c.title.padEnd(22)} ${c.detail}`);
  if (c.owner) console.log(`          ${''.padEnd(22)} owner: ${c.owner}`);
  if (c.action) console.log(`          ${''.padEnd(22)} -> ${c.action}`);
}

const checks = stagingEnvChecks(process.env);

console.log('\nstaging readiness\n');
for (const c of checks) print(c);

// --- the database, if we are allowed to look at it --------------------------
//
// Deliberately last and deliberately conditional. Connecting requires the URL
// to have already passed the name and not-the-live-one guards; a doctor that
// opened whatever it was handed would be the exact hazard it exists to catch.
const dbCheck = checks.find((c) => c.id === 'database')!;
const extra: ReadinessCheck[] = [];

if (dbCheck.status === 'ok') {
  const url = process.env.TWO_STAGING_DATABASE_URL!;
  let db;
  try {
    db = await openDb(url, { skipMigrations: true, poolMax: 2, applicationName: 'two-bot-staging-doctor' });
  } catch (err) {
    extra.push({
      id: 'database',
      title: 'database reachable',
      status: 'fix',
      detail: err instanceof Error ? err.message : String(err),
      action: 'check the host, the credentials and that the database exists',
    });
  }

  if (db) {
    try {
      const onDisk = loadMigrations(MIGRATIONS_DIR);
      let applied: { id: string }[] = [];
      try {
        applied = await db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all<{ id: string }>();
      } catch {
        // No schema_migrations table: nothing has ever been applied here.
      }
      const appliedIds = new Set(applied.map((a) => a.id));
      const pending = onDisk.filter((m) => !appliedIds.has(m.id));

      // Counting events needs the tables to exist, so only ask once the schema
      // is current. Everything after this point is a decision, not a query, and
      // lives in readiness.ts where it can be tested without Postgres.
      let counts: Record<string, number> | undefined;
      if (!pending.length) {
        const store = new EventStore(db);
        counts = {};
        // Scoped to the staging guild when we know it. The staging DB holds a
        // fixture set per guild id it has been seeded with, so an unscoped
        // count sums them and reports drift on a correct database. Undefined
        // when the guild id is not set yet - in that case the env check above
        // is already the headline, and an all-guild count is the best
        // available answer rather than a wrong one.
        const guildId = process.env.DISCORD_STAGING_GUILD_ID || undefined;
        for (const type of Object.keys(EXPECTED_FUNNEL)) {
          counts[type] = await store.countByType(type as EventType, guildId);
        }
      }

      extra.push(
        ...databaseStateChecks({
          pendingMigrations: pending.length,
          appliedMigrations: appliedIds.size,
          counts,
        }),
      );
    } finally {
      await db.close();
    }
  }

  console.log('');
  for (const c of extra) print(c);
}

// --- verdict ----------------------------------------------------------------
const all = [...checks, ...extra];
const v = verdict(all);

console.log('');
if (v === 'ready') {
  console.log('Ready. `node scripts/staging-reset.ts` then run the suite.\n');
} else if (v === 'fix') {
  console.log('Not ready - the FIX lines above are yours. Fix them and re-run this.\n');
} else {
  const waiting = all.filter((c) => c.status === 'blocked');
  console.log(`Not ready, and not on you: waiting on ${waiting.length} thing(s).`);
  for (const c of waiting) console.log(`  - ${c.title}: ${c.owner}`);
  console.log('\nRaise it on TWO-25 rather than working around it.\n');
}

process.exit(EXIT_CODE[v]);

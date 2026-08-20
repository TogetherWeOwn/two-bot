/**
 * Reset the staging database to the known fixture state.
 *
 *   node scripts/staging-reset.ts            # wipe this guild's rows, reseed
 *   node scripts/staging-reset.ts --check    # report only, change nothing
 *
 * QA runs this between integration runs. It needs no help from an engineer,
 * which is the whole point of TWO-25.
 *
 * FIVE GUARDS, because the failure this prevents is unrecoverable - seeding
 * ten fake members into the live funnel would corrupt every growth number we
 * have, and there is no undo:
 *
 *   1. It reads TWO_STAGING_DATABASE_URL. Not TWO_DATABASE_URL. A staging run
 *      cannot pick up the live connection string by inheriting the wrong shell.
 *   2. The database name must contain "staging" or "test".
 *   3. It must not point at the same host/database as TWO_DATABASE_URL, even
 *      under different credentials.
 *   4. DISCORD_STAGING_GUILD_ID must be set and must not be the live guild.
 *   5. Deletes are scoped to that guild id, never TRUNCATE.
 *
 * Guards 1-4 live in src/staging/readiness.ts so that this script's refusal and
 * `staging-doctor.ts`'s diagnosis are the same code and cannot drift. Any guard
 * failing exits 2 without touching the database.
 */
import { openDb } from '../src/store/db.ts';
import { EXPECTED_FUNNEL, resetStagingData, seedFixtures } from '../src/staging/fixtures.ts';
import { stagingGuildId } from '../src/staging/spec.ts';
import { stagingEnvChecks } from '../src/staging/readiness.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { joinedNeverPosted } from '../src/jobs/inactivity.ts';
import type { EventType } from '../src/core/events.ts';

const checkOnly = process.argv.includes('--check');

function die(msg: string): never {
  console.error(`\nstaging-reset: ${msg}\n`);
  process.exit(2);
}

// --- guards 1-4: the environment, checked once ------------------------------
//
// One shared implementation with staging-doctor.ts. A guard that only exists in
// the script people run when they are already confused is worth less than a
// guard that also explains itself in the one they run first.
const envChecks = stagingEnvChecks(process.env);
// Database first, because that is what this script actually opens - and the
// token is not its business at all: resetting touches the database only, and
// requiring a credential it never uses would just block QA.
for (const id of ['database', 'guild'] as const) {
  const c = envChecks.find((x) => x.id === id)!;
  if (c.status === 'ok') continue;
  die(
    `${c.title}: ${c.detail}\n` +
      (c.owner ? `  owner: ${c.owner}\n` : '') +
      (c.action ? `  -> ${c.action}\n` : '') +
      '  Nothing was written. See docs/STAGING.md, or run scripts/staging-doctor.ts.',
  );
}

const url = process.env.TWO_STAGING_DATABASE_URL!;
const dbName = new URL(url).pathname.replace(/^\//, '');
const guildId = stagingGuildId();

// --- do the work -----------------------------------------------------------
const db = await openDb(url);
try {
  const store = new EventStore(db);

  // One clock reading for the whole run. Fixture times are offsets from this,
  // and the idempotency key for repeatable events (join, leave, invite_click)
  // includes the timestamp - so calling the clock twice would produce two sets
  // of keys and silently double those counts.
  const now = new Date().toISOString();

  if (checkOnly) {
    console.log(`\nstaging database : ${dbName}`);
    console.log(`guild            : ${guildId}  (checking only, nothing written)\n`);
  } else {
    const r = await resetStagingData(db, { guildId, now });
    console.log(`\nstaging database : ${dbName}`);
    console.log(`guild            : ${guildId}`);
    console.log(`reset            : ${r.events} events written, ${r.members} member rows\n`);

    // Idempotency is a claim the script should prove, not assert. Reseeding on
    // top of a fresh seed must insert nothing.
    const again = await seedFixtures(db, { guildId, now });
    if (again.inserted !== 0) {
      console.error(
        `  WARNING  reseeding inserted ${again.inserted} extra events - fixtures are not ` +
          'idempotent. Report this on TWO-25 rather than working around it.\n',
      );
    }
  }

  // --- report the state QA is about to test against ------------------------
  let mismatched = 0;
  console.log('funnel state');
  for (const [type, expected] of Object.entries(EXPECTED_FUNNEL)) {
    const actual = await store.countByType(type as EventType);
    const ok = actual === expected;
    if (!ok) mismatched++;
    console.log(`  ${ok ? 'ok  ' : 'BAD '} ${type.padEnd(22)} ${actual}${ok ? '' : ` (expected ${expected})`}`);
  }

  const never = await joinedNeverPosted(db, guildId);
  console.log(`\njoined-never-posted: ${never.length} (${never.join(', ') || 'none'})\n`);

  if (mismatched) {
    console.error(`${mismatched} counts do not match the fixtures. Exiting non-zero.\n`);
    process.exit(1);
  }
  console.log('Known state. Safe to run the integration suite.\n');
} finally {
  await db.close();
}

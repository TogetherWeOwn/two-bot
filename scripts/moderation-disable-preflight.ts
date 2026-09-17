/**
 * "Can I turn moderation off right now?" - answered before you edit anything.
 *
 *   npm run moderation:disable-preflight
 *   npm run moderation:disable-preflight -- --json
 *
 * The same read the boot preflight performs (src/moderation/shutdownPreflight.ts),
 * run on demand so the operator learns the answer from a command instead of from
 * a bot that refuses to come back up. It writes nothing, runs no migrations, and
 * contacts Discord not at all - the whole point is that the answer comes from
 * our own tables, because a failed Discord fetch would read as "nothing
 * outstanding" and wave the disable through.
 *
 * Exit codes are the product:
 *   0  clear. Nothing outstanding; TWO_MODERATION=0 strands nobody.
 *   1  refused. Members and/or channels are still waiting; they are listed.
 *   2  could not tell. Missing TWO_DATABASE_URL, unreachable database - NOT a clear.
 *
 * A 2 is never a 0 on purpose. "I could not check" and "there is nothing to
 * check" are the same silence, and only one of them is safe.
 */
import {
  MODERATION_DISABLE_OVERRIDE_ENV,
  describeOutstanding,
  readOutstandingModerationState,
} from '../src/moderation/shutdownPreflight.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import { openDb } from '../src/store/db.ts';

const json = process.argv.includes('--json');

const url = process.env.TWO_DATABASE_URL?.trim() ?? '';
if (!url) {
  console.error('TWO_DATABASE_URL is required: this reads moderation state from the bot database.');
  process.exit(2);
}

let db;
try {
  db = await openDb(url, {
    skipMigrations: true,
    poolMax: 2,
    applicationName: 'two-bot-moderation-disable-preflight',
  });
} catch (err) {
  console.error(`could not open the database: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

try {
  const state = await readOutstandingModerationState(new ModerationStore(db));

  if (json) {
    console.log(JSON.stringify({ clear: state.total === 0, ...state }, null, 2));
  } else if (state.total === 0) {
    console.log('\nmoderation disable preflight: CLEAR');
    console.log('  0 pending unbans, 0 active lockdowns. TWO_MODERATION=0 strands nobody.\n');
  } else {
    console.log('\nmoderation disable preflight: REFUSED');
    console.log(describeOutstanding(state));
    console.log('');
    console.log('  Drain it: keep TWO_MODERATION=1 until the unban poller and /unlock clear these,');
    console.log('  or release them by hand. The bot refuses to boot with TWO_MODERATION unset while');
    console.log(`  any of it is outstanding, unless ${MODERATION_DISABLE_OVERRIDE_ENV}=1 is set - which`);
    console.log('  proceeds and logs this exact set as `moderation_disable_stranded`.\n');
  }

  process.exitCode = state.total === 0 ? 0 : 1;
} catch (err) {
  console.error(`could not read moderation state: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
} finally {
  await db.close();
}

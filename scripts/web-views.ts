/**
 * Create or update the `web_v1` contract views.
 *
 *   node scripts/web-views.ts            # apply sql/web_v1.sql
 *   node scripts/web-views.ts --status   # list what exists, change nothing
 *
 * Reads TWO_DATABASE_URL. Postgres only.
 *
 * The bot applies this at startup too, so on a normal deploy this is
 * belt-and-braces. It exists for the same reason scripts/migrate.ts does:
 * updating the contract *before* the new code rolls, and being able to look at
 * what the website can currently see without starting the bot.
 *
 * Run scripts/migrate.ts first - the views read tables that migration 0002
 * creates.
 */
import { openDb, isPostgresSpec } from '../src/store/db.ts';
import {
  applyWebContract,
  webSchemaFor,
  WEB_CONTRACT_VERSION,
  WEB_CONTRACT_VIEWS,
} from '../src/store/webContract.ts';

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url) {
  console.error('web-views: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
if (!isPostgresSpec(url)) {
  console.error(`web-views: TWO_DATABASE_URL is not a Postgres URL (${url.split(':')[0]}:...).`);
  process.exit(1);
}

const db = await openDb(url, { skipMigrations: true, applicationName: 'two-bot-web-views' });

try {
  const cur = await db.prepare(`SELECT current_schema() AS schema`).get<{ schema: string }>();
  const botSchema = cur?.schema ?? 'public';
  const webSchema = webSchemaFor(botSchema);

  if (!statusOnly) {
    await applyWebContract(db);
  }

  // Report from the catalogue, not from what we just tried to do. The point of
  // this script is to say what the database actually holds.
  const present = new Set(
    (
      await db
        .prepare(`SELECT table_name FROM information_schema.views WHERE table_schema = ?`)
        .all<{ table_name: string }>(webSchema)
    ).map((r) => r.table_name),
  );

  let missing = 0;
  for (const v of WEB_CONTRACT_VIEWS) {
    if (present.has(v)) {
      console.log(`ok       ${webSchema}.${v}`);
    } else {
      console.log(`MISSING  ${webSchema}.${v}`);
      missing++;
    }
  }

  // Anything in the schema that is not in the contract is a leak: the website's
  // role is granted SELECT on the whole schema, so a stray view is readable.
  for (const name of present) {
    if (!(WEB_CONTRACT_VIEWS as readonly string[]).includes(name)) {
      console.log(`EXTRA    ${webSchema}.${name}  (not in the contract - remove it or document it)`);
      missing++;
    }
  }

  console.log(
    `\nweb-views: contract v${WEB_CONTRACT_VERSION}, ` +
      `${WEB_CONTRACT_VIEWS.length} views, schema ${webSchema} (tables in ${botSchema}).`,
  );
  process.exitCode = missing > 0 ? 1 : 0;
} finally {
  await db.close();
}

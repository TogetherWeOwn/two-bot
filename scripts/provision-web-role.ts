/**
 * Create the website's database role: `two_web_ro`.
 *
 *   TWO_WEB_RO_PASSWORD=... node scripts/provision-web-role.ts
 *   node scripts/provision-web-role.ts --role two_web_ro_staging
 *
 * Reads TWO_DATABASE_URL as an administrator (it needs CREATEROLE).
 *
 * What this role can do, and nothing else:
 *   - connect to this database
 *   - USAGE on the web_v1 schema
 *   - SELECT on the views in it
 *
 * It cannot read `events`, `members` or any other table the bot owns, and it
 * cannot write anything anywhere: the role is read-only at the transaction
 * level, so even a bug in the website cannot issue a write.
 *
 * Idempotent. Run it again after adding a view; run it again to rotate the
 * password. It never prints the password and never logs it. The password goes
 * to the Web Lead through docs/SECRETS.md - never in an issue comment, never in
 * the repo.
 *
 * Run scripts/migrate.ts and scripts/web-views.ts first: this grants on views
 * that have to exist.
 *
 * Then prove it with `node scripts/verify-web-role.ts`, which connects AS the
 * role and checks. Do not take this script's word for it.
 */
import pg from 'pg';
import { webSchemaFor, WEB_CONTRACT_VIEWS } from '../src/store/webContract.ts';
import { provisionWebRole } from '../src/store/webRole.ts';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url) {
  console.error('provision-web-role: TWO_DATABASE_URL is not set.');
  process.exit(1);
}

const role = flag('role', 'two_web_ro');
const password = process.env.TWO_WEB_RO_PASSWORD?.trim();

const client = new pg.Client({ connectionString: url, application_name: 'two-bot-provision-role' });
await client.connect();

try {
  const cur = await client.query<{ schema: string }>(`SELECT current_schema() AS schema`);
  const botSchema = flag('bot-schema', cur.rows[0]?.schema ?? 'public');
  const webSchema = flag('web-schema', webSchemaFor(botSchema));

  const r = await provisionWebRole(client, { role, password, botSchema, webSchema });

  console.log(`provision-web-role: role     ${r.role} (${r.created ? 'created' : 'updated'})`);
  console.log(`provision-web-role: password ${r.passwordSet ? 'set' : 'unchanged'}`);
  console.log(`provision-web-role: reads    ${r.webSchema} (${WEB_CONTRACT_VIEWS.length} views)`);
  console.log(`provision-web-role: denied   ${r.botSchema} (the bot's own tables)`);
  console.log(`\nNow prove it: node scripts/verify-web-role.ts`);
} catch (err) {
  console.error(`provision-web-role: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

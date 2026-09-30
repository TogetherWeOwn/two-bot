/**
 * Prove the website's role can read the contract views and nothing else.
 *
 *   TWO_WEB_RO_DATABASE_URL=postgres://two_web_ro:...@host/two node scripts/verify-web-role.ts
 *
 * or, to build the URL from the admin one:
 *
 *   TWO_DATABASE_URL=... TWO_WEB_RO_PASSWORD=... node scripts/verify-web-role.ts
 *
 * Exits non-zero if any check fails, so it belongs in CI. That is the reason it
 * exists: a migration a year from now must not be able to quietly hand the
 * website more access than it needs, and nobody will remember to check by hand.
 *
 * This connects AS the website's role and tries the queries. It does not read
 * a permissions table and infer an answer - see src/store/webRoleCheck.ts.
 */
import pg from 'pg';
import { webSchemaFor } from '../src/store/webContract.ts';
import { runWebRoleChecks, summarise } from '../src/store/webRoleCheck.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-web-role.ts [--role <name>] [--bot-schema <schema>] [--web-schema <schema>]');
  process.exit(0);
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const role = flag('role', 'two_web_ro');
const botSchema = flag('bot-schema', 'public');
const webSchema = flag('web-schema', webSchemaFor(botSchema));

let url = process.env.TWO_WEB_RO_DATABASE_URL?.trim();

if (!url) {
  const admin = process.env.TWO_DATABASE_URL?.trim();
  const password = process.env.TWO_WEB_RO_PASSWORD?.trim();
  if (!admin || !password) {
    console.error('verify-web-role: set TWO_WEB_RO_DATABASE_URL, or TWO_DATABASE_URL + TWO_WEB_RO_PASSWORD.');
    process.exit(1);
  }
  // Swap the credentials on the admin URL, keeping host/port/database. Built
  // here and never printed: the whole URL is a secret once it has a password.
  const u = new URL(admin);
  u.username = role;
  u.password = password;
  url = u.toString();
}

const client = new pg.Client({ connectionString: url, application_name: 'two-bot-verify-web-role' });

try {
  await client.connect();
} catch (err) {
  // Deliberately does not echo the URL - it carries the password.
  console.error(`verify-web-role: could not connect as ${role}: ${(err as Error).message}`);
  process.exit(1);
}

try {
  const who = await client.query<{ user: string }>(`SELECT current_user AS user`);
  if (who.rows[0].user !== role) {
    console.error(
      `verify-web-role: connected as ${who.rows[0].user}, not ${role}. ` +
        `Verifying with the wrong role proves nothing.`,
    );
    process.exit(1);
  }

  const results = await runWebRoleChecks(client, { botSchema, webSchema });

  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}  -  ${r.detail}`);
  }

  const { passed, failed } = summarise(results);
  console.log(`\nverify-web-role: ${passed} passed, ${failed} failed (role ${role}, schema ${webSchema}).`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  await client.end();
}

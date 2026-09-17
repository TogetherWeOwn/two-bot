/**
 * "The website role can read the views and nothing else" - as a check that
 * runs, rather than a sentence in a document.
 *
 * These checks connect AS the website's role and try things. They never read a
 * permission flag and conclude anything from it: several ways of asking
 * Postgres "can this role read that" give an answer that is true in the
 * catalogue and wrong at the point of use - a grant to PUBLIC, an inherited
 * role, a default privilege that fires on the next table. The only answer worth
 * having is what happens when you run the query.
 *
 * Shared by scripts/verify-web-role.ts (CI, and after every provision) and by
 * test/e2e.webcontract.test.ts, so the thing CI enforces and the thing the
 * tests assert cannot drift apart.
 */
import type pg from 'pg';
import { WEB_CONTRACT_VERSION, WEB_CONTRACT_VIEWS } from './webContract.ts';

/** SQLSTATEs that all mean "the database refused, as intended". */
const DENIED = new Set([
  '42501', // insufficient_privilege
  '25006', // read_only_sql_transaction
  '55000', // object_not_in_prerequisite_state (view is not auto-updatable)
  '42P01', // undefined_table - the object is not even reachable
  '3F000', // invalid_schema_name - USAGE was never granted
]);

export interface CheckResult {
  name: string;
  ok: boolean;
  /** What actually happened. Present whether it passed or failed. */
  detail: string;
}

export interface CheckOptions {
  /** Schema holding the bot's own tables. Production: `public`. */
  botSchema: string;
  /** Schema holding the contract views. Production: `web_v1`. */
  webSchema: string;
  /** Bot-owned tables that must be unreadable. */
  botTables?: string[];
}

/**
 * Every table the migrations create. All of them must be denied.
 *
 * Keep this in step when a migration adds one. It is not the safety net — the
 * census check at the end of `runWebRoleChecks` catches a table nobody listed
 * here — but a named check says *which* table and why, where a census failure
 * only says that something is readable.
 */
export const BOT_TABLES = [
  // 0001 — the funnel log
  'events',
  'members',
  'invite_snapshots',
  'schema_migrations',
  // 0002 — internal actions (TOG-44). The audit trail and the idempotency
  // hashes in particular have no business behind a public website.
  'internal_nonces',
  'internal_idempotency',
  'internal_action_log',
  'internal_discord_events',
  // 0011 — Discord operational metadata. Staff-only and never exposed through
  // web_v1, even though message bodies and names are deliberately absent.
  'operational_audit_log',
  // 0010 — private moderation history and scheduled tempban expiry.
  'moderation_warnings',
  'moderation_scheduled_unbans',
  'moderation_audit',
  'moderation_lockdowns',
  'moderation_idempotency',
  'automod_violations',
  'automod_processed_messages',
  // 0015–0017 — private automation definitions, delivery state and audit.
  'automation_commands',
  'scheduled_messages',
  'sticky_messages',
  'automation_audit_log',
  // 0015 — destructive-action evidence and private member risk flags.
  'containment_events',
  'containment_incidents',
  'join_risk_flags',
  // 0013/0014 — private support tickets and transcript bodies.
  'tickets',
  'ticket_transcripts',
  // 0010 — member-level XP and staff-configured role rewards.
  'member_levels',
  'xp_cooldowns',
  'xp_awards',
  'level_role_rewards',
  'level_import_runs',
  // 0018+ — private self-role mutation and recovery evidence.
  'self_role_audit',
  'self_role_panel_claims',
  // 0018 — private community classification inputs, heartbeat state and alerts.
  'community_facts',
  'community_stream_heartbeats',
  'community_scorecard_runs',
  'community_scorecard_alerts',
  // 0003 — the tables behind this contract. The website reads the views over
  // them, never these.
  'web_contract_meta',
  'guild_counters',
  'rank_ladder',
  'rank_snapshots',
  'member_ranks',
  'scheduled_events',
  // 0004 is an internal instrument and 0005 holds bot-owned snapshot/exclusion
  // state. Neither is reachable from a contract view except through aggregates.
  'presence_probe',
  'counter_snapshots',
  'member_exclusions',
  // 0006 — the tracked invite links behind go.two.gg (TOG-116). Nothing
  // member-level, but it names every place we advertise the server, which is
  // marketing posture rather than anything a visitor's browser should see.
  'invite_campaigns',
  // 0024/0025 — announcements, LFG sign-ups, and feed relays (TOG-1649).
  // RSVP state and raid rosters are member activity, and the audit log plus
  // delivery claims are operational internals; none of it is public.
  'event_rsvps',
  'lfg_posts',
  'lfg_roles',
  'lfg_signups',
  'feed_relays',
  'feed_deliveries',
  'announcements_audit_log',
  // 0026 — the config store (TOG-3100). The most consequential write target on
  // this list: a row here changes how the bot behaves at the next poll, so a
  // website role that could write one would be configuring the bot rather than
  // reading from it. The audit table is append-only even to the bot, and must
  // not be reachable at all - otherwise the record of who changed what is
  // editable by the party it exists to hold to account.
  'guild_settings',
  'guild_settings_audit',
];

function ident(schema: string, name: string): string {
  return `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;
}

/** Run `sql`, rolling back whatever it did, and report how it ended. */
async function attempt(
  client: pg.Client,
  sql: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await client.query(sql);
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code ?? 'unknown', message: e.message ?? String(err) };
  }
}

/**
 * A statement that must fail. Wrapped in its own transaction so that the
 * aborted state does not poison the checks after it.
 */
async function mustFail(client: pg.Client, name: string, sql: string): Promise<CheckResult> {
  await attempt(client, 'BEGIN');
  const r = await attempt(client, sql);
  await attempt(client, 'ROLLBACK');

  if (r.ok) {
    return { name, ok: false, detail: 'SUCCEEDED - it was supposed to be refused' };
  }
  return {
    name,
    ok: DENIED.has(r.code),
    detail: DENIED.has(r.code)
      ? `refused (${r.code})`
      : `failed with ${r.code}, which is not a refusal: ${r.message}`,
  };
}

/**
 * @param client connected AS the website's role. Not as an administrator - the
 *   whole point is to see what that role sees.
 */
export async function runWebRoleChecks(
  client: pg.Client,
  opts: CheckOptions,
): Promise<CheckResult[]> {
  const { botSchema, webSchema } = opts;
  const botTables = opts.botTables ?? BOT_TABLES;
  const out: CheckResult[] = [];

  // --- it can read the contract ------------------------------------------
  for (const view of WEB_CONTRACT_VIEWS) {
    const r = await attempt(client, `SELECT * FROM ${ident(webSchema, view)} LIMIT 1`);
    out.push({
      name: `read ${webSchema}.${view}`,
      ok: r.ok,
      detail: r.ok ? 'readable' : `REFUSED (${r.code}): ${r.message}`,
    });
  }

  // --- and the shapes the contract promises -------------------------------
  try {
    const one = await client.query(`SELECT count(*)::int AS n FROM ${ident(webSchema, 'live_counts')}`);
    const n = one.rows[0].n as number;
    out.push({
      name: 'live_counts returns exactly one row',
      ok: n === 1,
      detail: `${n} row(s)`,
    });
  } catch (err) {
    out.push({ name: 'live_counts returns exactly one row', ok: false, detail: String(err) });
  }

  try {
    const ranks = await client.query(
      `SELECT rank_key, rank_order FROM ${ident(webSchema, 'rank_counts')} ORDER BY rank_order`,
    );
    const keys = ranks.rows.map((r) => r.rank_key as string);
    const expected = ['prospect', 'member', 'soldier', 'veteran', 'legend'];
    out.push({
      name: 'rank_counts returns all five ranks in ladder order',
      ok: keys.join(',') === expected.join(','),
      detail: keys.length ? keys.join(' -> ') : 'no rows',
    });
  } catch (err) {
    out.push({ name: 'rank_counts returns all five ranks in ladder order', ok: false, detail: String(err) });
  }

  try {
    const meta = await client.query(
      `SELECT contract_version FROM ${ident(webSchema, 'contract_meta')}`,
    );
    const v = meta.rows[0]?.contract_version as string | undefined;
    out.push({
      name: `contract_meta reports v${WEB_CONTRACT_VERSION}`,
      ok: v === WEB_CONTRACT_VERSION,
      detail: v ? `v${v}` : 'no row',
    });
  } catch (err) {
    out.push({ name: `contract_meta reports v${WEB_CONTRACT_VERSION}`, ok: false, detail: String(err) });
  }

  // --- and nothing else ---------------------------------------------------
  for (const table of botTables) {
    out.push(
      await mustFail(client, `cannot read ${botSchema}.${table}`, `SELECT * FROM ${ident(botSchema, table)} LIMIT 1`),
    );
  }

  // Probe `upcoming_events` specifically: it is a plain SELECT over one table,
  // which makes it auto-updatable, so Postgres gets as far as checking
  // permissions. `live_counts` has a join and would be refused with 55000
  // "not auto-updatable" whatever the grants said - a check that passes because
  // of how the view is shaped tells you nothing about who is allowed to write.
  out.push(
    await mustFail(
      client,
      'cannot write to a contract view',
      `INSERT INTO ${ident(webSchema, 'upcoming_events')} (event_id, name, starts_at) VALUES ('probe', 'probe', '2030-01-01T00:00:00.000Z')`,
    ),
  );
  out.push(
    await mustFail(
      client,
      "cannot write to the bot's tables",
      `INSERT INTO ${ident(botSchema, 'guild_counters')} (guild_id) VALUES ('probe')`,
    ),
  );
  out.push(await mustFail(client, 'cannot create a table', `CREATE TABLE web_role_probe (id int)`));
  out.push(
    await mustFail(client, 'cannot create a table in the web schema', `CREATE TABLE ${ident(webSchema, 'probe')} (id int)`),
  );

  // --- the census ---------------------------------------------------------
  //
  // The check that actually earns the phrase "and nothing else". Everything
  // above is a list someone wrote down, so it can only catch what that person
  // thought of. This asks Postgres to enumerate every relation in the database
  // and say which ones this role can select from - so a table added next year,
  // or a grant to PUBLIC that nobody associated with this role, shows up here
  // without anyone having to predict it.
  try {
    const census = await client.query<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v','m','p','f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND has_table_privilege(current_user, c.oid, 'SELECT')
        ORDER BY 1, 2`,
    );

    const allowed = new Set(WEB_CONTRACT_VIEWS.map((v) => `${webSchema}.${v}`));
    const actual = census.rows.map((r) => `${r.schema}.${r.name}`);
    const extra = actual.filter((k) => !allowed.has(k));
    const missing = [...allowed].filter((k) => !actual.includes(k));

    out.push({
      name: 'can select from the contract views and nothing else',
      ok: extra.length === 0 && missing.length === 0,
      detail:
        extra.length === 0 && missing.length === 0
          ? `exactly ${actual.length} relations, all in ${webSchema}`
          : [
              extra.length ? `READABLE BUT SHOULD NOT BE: ${extra.join(', ')}` : '',
              missing.length ? `NOT READABLE BUT SHOULD BE: ${missing.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join(' | '),
    });
  } catch (err) {
    out.push({ name: 'can select from the contract views and nothing else', ok: false, detail: String(err) });
  }

  // The transaction-level guarantee, read back from the server rather than
  // assumed from the ALTER ROLE we issued.
  try {
    // current_setting(), not SHOW: SHOW names its result column after the
    // parameter, so `rows[0].setting` is undefined and the check reads as
    // failing-for-the-wrong-reason.
    const ro = await client.query<{ setting: string }>(
      `SELECT current_setting('default_transaction_read_only') AS setting`,
    );
    out.push({
      name: 'session is read-only by default',
      ok: ro.rows[0].setting === 'on',
      detail: `default_transaction_read_only = ${ro.rows[0].setting}`,
    });
  } catch (err) {
    out.push({ name: 'session is read-only by default', ok: false, detail: String(err) });
  }

  return out;
}

export function summarise(results: CheckResult[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const r of results) (r.ok ? passed++ : failed++);
  return { passed, failed };
}

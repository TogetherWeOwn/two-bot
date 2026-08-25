/**
 * The website's database role: create it, and grant it exactly the contract.
 *
 * Kept out of the script so the same code that provisions production is the
 * code the tests exercise. A grant path that only production ever runs is a
 * grant path nobody has checked.
 */
import type pg from 'pg';

/** Identifiers are interpolated into DDL, not bound. Be strict. */
export function assertSafeIdent(kind: string, name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,58}$/.test(name)) {
    throw new Error(`unsafe ${kind}: ${name}`);
  }
}

export interface ProvisionOptions {
  role: string;
  /** Omit to leave an existing role's password alone. Required to create one. */
  password?: string;
  /** Schema holding the bot's tables. Production: `public`. */
  botSchema: string;
  /** Schema holding the contract views. Production: `web_v1`. */
  webSchema: string;
}

export interface ProvisionResult {
  role: string;
  created: boolean;
  passwordSet: boolean;
  botSchema: string;
  webSchema: string;
  database: string;
}

/**
 * @param client connected as an administrator (needs CREATEROLE).
 */
export async function provisionWebRole(
  client: pg.Client,
  opts: ProvisionOptions,
): Promise<ProvisionResult> {
  const { role, password, botSchema, webSchema } = opts;
  assertSafeIdent('role name', role);
  assertSafeIdent('schema name', botSchema);
  assertSafeIdent('schema name', webSchema);

  const meta = await client.query<{ db: string }>(`SELECT current_database() AS db`);
  const database = meta.rows[0].db;
  assertSafeIdent('database name', database);

  const schemaExists = await client.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
    [webSchema],
  );
  if (schemaExists.rowCount === 0) {
    throw new Error(`schema ${webSchema} does not exist - apply sql/web_v1.sql first`);
  }

  const existing = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
  const roleExisted = (existing.rowCount ?? 0) > 0;

  if (!roleExisted && !password) {
    throw new Error(`role ${role} does not exist and no password was given - a LOGIN role with no password is a role anyone can be`);
  }

  if (password) {
    // CREATE/ALTER ROLE cannot take a bind parameter, so let Postgres do the
    // escaping and interpolate what it hands back. Never hand-escape a secret
    // into SQL, and never let one reach a log line or an argv.
    const lit = await client.query<{ lit: string }>(`SELECT quote_literal($1::text) AS lit`, [password]);
    await client.query(
      roleExisted
        ? `ALTER ROLE ${role} WITH LOGIN PASSWORD ${lit.rows[0].lit}`
        : `CREATE ROLE ${role} WITH LOGIN PASSWORD ${lit.rows[0].lit}`,
    );
  }

  // Read-only at the transaction level: the belt to the grants' braces. Even if
  // a future migration accidentally grants INSERT somewhere, the statement
  // still fails before it touches anything.
  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await client.query(`ALTER ROLE ${role} CONNECTION LIMIT 20`);
  // The website must never migrate this database - two migrators sharing
  // schema_migrations is a bad time (migrations/README.md).
  await client.query(`ALTER ROLE ${role} NOCREATEDB NOCREATEROLE NOSUPERUSER NOINHERIT`);

  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);

  // No access to the bot's own tables. Explicitly, not by omission: a REVOKE
  // that was never needed costs nothing and outlives someone later granting
  // something by hand.
  for (const stmt of [
    `REVOKE ALL ON SCHEMA ${botSchema} FROM ${role}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${botSchema} FROM ${role}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${botSchema} FROM ${role}`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${botSchema} FROM ${role}`,
  ]) {
    await client.query(stmt);
  }

  // Exactly the views, exactly SELECT.
  await client.query(`GRANT USAGE ON SCHEMA ${webSchema} TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${webSchema} TO ${role}`);
  // So a view added by a later `web:views` run is readable without anyone
  // remembering to come back here. Applies to objects created by the role
  // running this statement, which is the role that owns the views.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${webSchema} GRANT SELECT ON TABLES TO ${role}`,
  );

  return {
    role,
    created: !roleExisted,
    passwordSet: Boolean(password),
    botSchema,
    webSchema,
    database,
  };
}

/** Undo. Used by the tests; also the documented rollback for a bad provision. */
export async function dropWebRole(client: pg.Client, role: string, schemas: string[]): Promise<void> {
  assertSafeIdent('role name', role);
  const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
  if (exists.rowCount === 0) return;

  // A role cannot be dropped while anything still references it, and grants
  // count as references.
  for (const s of schemas) {
    assertSafeIdent('schema name', s);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE SELECT ON TABLES FROM ${role}`);
  }
  await client.query(`DROP OWNED BY ${role}`);
  await client.query(`DROP ROLE ${role}`);
}

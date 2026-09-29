/**
 * Test-database host guard (TOG-9656, follow-up to the 2026-09-29 production
 * DB wipe in TOG-9646): agents must never test against production services.
 *
 * WHY THIS EXISTS. The test helper used to accept any postgres:// URL, so a
 * `TWO_TEST_DATABASE_URL` pointed at a production or staging host would
 * happily DROP/CREATE schemas there. This module is the single allowlist: the
 * Paperclip sandbox database (`agent-testdb`), loopback (local dev, CI
 * service containers mapped to 127.0.0.1, owned-cluster fixtures), and the CI
 * `postgres` service-container hostname. Everything else — production,
 * staging, or anything unparsable — is refused before a connection is opened,
 * so before any migration runs.
 *
 * Dependency-free on purpose. It is imported at test-helper import time, and
 * `scripts/require-suites.ts` is executed from a bare fixture tree in
 * `test/unit.restartstorageci.test.ts`, so this file must stay import-free.
 */

/** Hosts a test database is allowed to live on. Compare with `testDatabaseHost`. */
export const ALLOWED_TEST_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  // Paperclip agent sandbox (Postgres 17, isolated network, disposable data).
  'agent-testdb',
  // Local dev (`createdb` + loopback), CI jobs (service container
  // port-mapped to 127.0.0.1), owned-cluster fixtures (ephemeral ports).
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  // GitHub Actions `services.postgres` reachable by its service hostname.
  'postgres',
]);

/** Lowercased hostname of a database URL, or '' when it has none. */
export function testDatabaseHost(url: string): string {
  return parsedTestDatabaseUrl(url).host;
}

/**
 * Hostname plus whether the URL carries a query string. node-postgres (via
 * pg-connection-string) promotes query params over the hostname/port — e.g.
 * `postgres://u@127.0.0.1:5432/x?host=db.internal` connects to db.internal
 * while `URL.hostname` still says 127.0.0.1 — so a bare hostname allowlist is
 * bypassable. There is no legitimate query-param use (CI sets bare URLs;
 * schema selection uses driver options), so any query string is refused.
 */
function parsedTestDatabaseUrl(url: string): { host: string; hasQuery: boolean } {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    return { host: host.endsWith('.') ? host.slice(0, -1) : host, hasQuery: parsed.search !== '' };
  } catch {
    return { host: '', hasQuery: false };
  }
}

/** True when the URL points at an allowlisted test host with no query string. */
export function isAllowedTestDatabaseUrl(url: string): boolean {
  const parsed = parsedTestDatabaseUrl(url);
  return !parsed.hasQuery && ALLOWED_TEST_DATABASE_HOSTS.has(parsed.host);
}

/**
 * Return the URL unchanged when it points at an allowlisted test host, else
 * throw before the caller opens any connection — so before any migration
 * runs. Never catch this to fall back to another database.
 */
export function assertTestDatabaseHost(url: string, label = 'TWO_TEST_DATABASE_URL'): string {
  const parsed = parsedTestDatabaseUrl(url);
  if (parsed.hasQuery) {
    throw new Error(
      `${label} carries a query string, which node-postgres promotes over the hostname ` +
        '(?host=/?port= retarget the connection), refusing to run. Pass a bare database URL. ' +
        'Tests may only target agent-testdb (Paperclip sandbox, one database per card, e.g. two_bot_test_togXXXX), ' +
        '127.0.0.1/localhost (local dev, CI service containers, owned test clusters), or the CI "postgres" ' +
        'service container. Production and staging hosts are never valid test targets.',
    );
  }
  if (ALLOWED_TEST_DATABASE_HOSTS.has(parsed.host)) return url;
  throw new Error(
    `${label} host "${parsed.host || '(unparsable)'}" is not an isolated test database, refusing to run. ` +
      'Tests may only target agent-testdb (Paperclip sandbox, one database per card, e.g. two_bot_test_togXXXX), ' +
      '127.0.0.1/localhost (local dev, CI service containers, owned test clusters), or the CI "postgres" ' +
      'service container. Production and staging hosts are never valid test targets.',
  );
}

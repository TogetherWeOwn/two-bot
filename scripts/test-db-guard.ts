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
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.endsWith('.') ? host.slice(0, -1) : host;
  } catch {
    return '';
  }
}

/** True when the URL points at an allowlisted test host. */
export function isAllowedTestDatabaseUrl(url: string): boolean {
  return ALLOWED_TEST_DATABASE_HOSTS.has(testDatabaseHost(url));
}

/**
 * Return the URL unchanged when it points at an allowlisted test host, else
 * throw before the caller opens any connection — so before any migration
 * runs. Never catch this to fall back to another database.
 */
export function assertTestDatabaseHost(url: string, label = 'TWO_TEST_DATABASE_URL'): string {
  const host = testDatabaseHost(url);
  if (ALLOWED_TEST_DATABASE_HOSTS.has(host)) return url;
  throw new Error(
    `${label} host "${host || '(unparsable)'}" is not an isolated test database, refusing to run. ` +
      'Tests may only target agent-testdb (Paperclip sandbox, one database per card, e.g. two_bot_test_togXXXX), ' +
      '127.0.0.1/localhost (local dev, CI service containers, owned test clusters), or the CI "postgres" ' +
      'service container. Production and staging hosts are never valid test targets.',
  );
}

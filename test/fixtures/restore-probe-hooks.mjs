// Hermetic target doubles for pg-restore's dry-run probe. The real dump reader
// inspects local fixture bytes; no database driver or socket module can load.
// Source: https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions
import { registerHooks } from 'node:module';

const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
const migrateUrl = new URL('../../src/store/migrate.ts', import.meta.url).href;
const networkModules = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram']);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'pg' || networkModules.has(specifier.replace(/^node:/, ''))) {
      throw new Error(`offline restore probe must not load ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const prelude = `
      import { appendFileSync } from 'node:fs';
      const trace = (operation) => appendFileSync(process.env.RESTORE_PROBE_TRACE, operation + '\\n');
      function fail(phase, table) {
        if (process.env.RESTORE_PROBE_PHASE !== phase) return;
        if (table && table !== process.env.RESTORE_PROBE_TABLE) return;
        const error = new Error(process.env.RESTORE_PROBE_MESSAGE || 'synthetic target failure');
        if (process.env.RESTORE_PROBE_CODE) error.code = process.env.RESTORE_PROBE_CODE;
        throw error;
      }
      function forbidden(operation) {
        trace(operation);
        throw new Error('dry-run attempted ' + operation);
      }
    `;
    if (url === dbUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `${prelude}
          export const isPostgresSpec = (url) => url.startsWith('postgres://');
          export async function openDb(spec, options) {
            trace('open ' + JSON.stringify(options));
            fail('open');
            return {
              prepare(sql) {
                // The probe COUNT is deliberately unqualified: it reads through
                // the same search_path the --force restore uses. A 42P01 from
                // it is ambiguous (missing table vs USAGE-denied schema hidden
                // from name resolution), so the CLI disambiguates with a
                // catalog visibility query before calling anything missing.
                const count = /^SELECT COUNT\\(\\*\\) AS n FROM ([a-z_]+)$/.exec(sql);
                if (count) {
                  const table = count[1];
                  trace('prepare ' + sql);
                  fail('prepare', table);
                  return {
                    async get() {
                      trace('get ' + table);
                      fail('get', table);
                      return { n: table === 'events' ? 17 : 3 };
                    },
                    all: async () => forbidden('all'),
                    run: async () => forbidden('write'),
                  };
                }
                if (sql.replace(/\\s+/g, ' ').trim() ===
                    "SELECT n.nspname AS schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = ? AND c.relkind IN ('r', 'p', 'v', 'm', 'f')") {
                  trace('visibility-prepare');
                  return {
                    get: async () => forbidden('visibility-get'),
                    async all(table) {
                      trace('visibility ' + table);
                      fail('visibility', String(table));
                      const mode = process.env.RESTORE_PROBE_VISIBILITY || 'absent';
                      if (mode === 'fail') throw new Error('synthetic visibility failure');
                      if (mode === 'hidden') return [{ schema: 'denied_schema' }];
                      if (mode === 'off-path') return [{ schema: 'other_schema' }];
                      return [];
                    },
                    run: async () => forbidden('write'),
                  };
                }
                return forbidden('unexpected SQL ' + sql);
              },
              exec: async () => forbidden('exec'),
              transaction: async () => forbidden('transaction'),
              close: async () => { trace('close'); fail('close'); },
            };
          }
        `,
      };
    }
    if (url === migrateUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `${prelude}
          export async function migrate() { forbidden('migrate'); }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

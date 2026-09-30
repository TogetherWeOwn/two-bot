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
                trace('prepare ' + sql);
                const match = /^SELECT COUNT\\(\\*\\) AS n FROM ([a-z_]+)$/.exec(sql);
                if (!match) return forbidden('unexpected SQL ' + sql);
                const table = match[1];
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

// Offline dependencies for the real pg-restore CLI (TOG-10566). No database,
// no migrations on disk: openDb/migrate are poison doubles that record every
// call in RESTORE_TEST_TRACE, so a refused backup must leave the trace empty
// and a valid one must show open -> migrate -> transaction -> close.
import { registerHooks } from 'node:module';

const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
const migrateUrl = new URL('../../src/store/migrate.ts', import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (url === dbUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { appendFileSync } from 'node:fs';
          const trace = () => process.env.RESTORE_TEST_TRACE;
          const columns = () => JSON.parse(process.env.RESTORE_TEST_COLUMNS || '{}');
          const counts = () => JSON.parse(process.env.RESTORE_TEST_COUNTS || '{}');
          export const isPostgresSpec = (url) =>
            typeof url === 'string' && url.startsWith('postgres://');
          function statement(sql) {
            return {
              get: async (...params) => {
                if (/COUNT\\(\\*\\)/i.test(sql)) {
                  const m = sql.match(/FROM\\s+([A-Za-z_][\\w]*)/i);
                  const table = m && m[1];
                  return { n: table && counts()[table] !== undefined ? counts()[table] : 0 };
                }
                return undefined;
              },
              all: async (...params) => {
                if (sql.includes('information_schema')) {
                  return ((columns()[params[0]]) || []).map((c) => ({ column_name: c }));
                }
                return [];
              },
              run: async (...params) => ({ changes: params.length }),
            };
          }
          export async function openDb() {
            appendFileSync(trace(), 'open\\n');
            const db = {
              prepare: (sql) => statement(sql),
              exec: async (sql) => { appendFileSync(trace(), 'exec\\n'); },
              transaction: async (fn) => {
                appendFileSync(trace(), 'transaction\\n');
                return fn(db);
              },
              close: async () => { appendFileSync(trace(), 'close\\n'); },
            };
            return db;
          }
        `,
      };
    }
    if (url === migrateUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { appendFileSync } from 'node:fs';
          export async function migrate() {
            appendFileSync(process.env.RESTORE_TEST_TRACE, 'migrate\\n');
            return [];
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

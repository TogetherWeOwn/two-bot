// Offline dependencies for the real pg-backup CLI. No database or remote upload.
import { registerHooks } from 'node:module';

const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
const dumpUrl = new URL('../../src/store/dump.ts', import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (url === dbUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { appendFileSync } from 'node:fs';
          export const isPostgresSpec = (url) => url.startsWith('postgres://');
          export async function openDb() {
            appendFileSync(process.env.BACKUP_TEST_TRACE, 'open\\n');
            return { close: async () => {
              appendFileSync(process.env.BACKUP_TEST_TRACE, 'close\\n');
            } };
          }
        `,
      };
    }
    if (url === dumpUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { appendFileSync, writeFileSync } from 'node:fs';
          import { gzipSync } from 'node:zlib';
          export async function dump(_db, out) {
            const count = Number(process.env.BACKUP_TEST_EVENT_COUNT);
            const manifest = {
              kind: 'manifest', version: 4, createdAt: new Date().toISOString(),
              tables: [{ name: 'events', columns: ['id'], count }],
              eventsSequence: count, sequences: { events: count }, schemaMigrations: [],
            };
            const rows = Array.from({ length: count }, (_, i) => ({
              kind: 'row', table: 'events', data: { id: i + 1 },
            }));
            const lines = [manifest, ...rows, { kind: 'end', rows: count }];
            writeFileSync(out, gzipSync(lines.map((line) => JSON.stringify(line)).join('\\n') + '\\n'));
            appendFileSync(process.env.BACKUP_TEST_TRACE, 'dump\\n');
            return manifest;
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

// Hermetic dependencies for the real restore CLI's argument grammar. Every
// file/target operation is traced; no driver or real target can be loaded.
import { registerHooks } from 'node:module';

const modules = new Map([
  [new URL('../../src/store/db.ts', import.meta.url).href, `
    export const isPostgresSpec = (url) => url.startsWith('postgres://');
    export async function openDb() {
      trace('open');
      return {
        prepare: () => ({ get: async () => { trace('query'); return { n: 0 }; } }),
        close: async () => trace('close'),
      };
    }
  `],
  [new URL('../../src/store/migrate.ts', import.meta.url).href, `
    export async function migrate() { trace('migrate'); }
  `],
  [new URL('../../src/store/dump.ts', import.meta.url).href, `
    export const DUMP_TABLES = ['events'];
    const manifest = {
      createdAt: '2026-09-30T00:00:00.000Z',
      schemaMigrations: [],
      tables: [{ name: 'events', count: 0 }],
    };
    export async function inspect() {
      trace('inspect');
      return { manifest, buffers: new Map([['events', []]]), rows: 0 };
    }
    export async function restore() {
      trace('restore');
      return { manifest, restored: { events: 0 }, droppedColumns: {}, ok: true };
    }
  `],
]);

registerHooks({
  load(url, context, nextLoad) {
    const source = modules.get(url);
    if (source !== undefined) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { appendFileSync } from 'node:fs';
          const trace = (operation) => appendFileSync(process.env.RESTORE_TEST_TRACE, operation + '\\n');
          ${source}
        `,
      };
    }
    return nextLoad(url, context);
  },
});

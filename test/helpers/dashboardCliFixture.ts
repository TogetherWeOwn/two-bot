/** Substitute the Db before the real dashboard CLI loads; never connect. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dashboardDb, assertDashboardGuildReads, type DashboardRead } from './dashboardDbFixture.ts';

export async function openDb(spec: string) {
  assert.equal(spec, 'fixture://dashboard');
  console.error('fixture: openDb');
  const reads: DashboardRead[] = [];
  const db = dashboardDb(JSON.parse(process.env.DASHBOARD_FIXTURE!), reads);
  db.close = async () => {
    assertDashboardGuildReads(reads, 'dashboard-target');
    console.error('fixture: close');
  };
  return db;
}

const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url === dbUrl) {
      return {
        format: 'module', shortCircuit: true,
        source: `export { openDb } from ${JSON.stringify(import.meta.url)};`,
      };
    }
    return nextLoad(url, context);
  },
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const SCRIPT = new URL('../scripts/onboarding-exploratory-acceptance.ts', import.meta.url).href;
const STORE = new URL('../src/store/eventStore.ts', import.meta.url).href;
const SESSION = new URL('../src/onboarding/session.ts', import.meta.url).href;
const ORDER_PROBE = 'DEFECT? channelIds follow catalog order as SessionPlan documents';

function assertProbeOutcome(run: { status: number | null; output: string }): void {
  // Section D can pass once main fixes the defect. Nothing else may fail.
  const failures = run.output.match(/^FAIL .+$/gm) ?? [];
  for (const failure of failures) {
    assert.ok(failure.startsWith(`FAIL ${ORDER_PROBE}  -  `), run.output);
  }
  assert.ok(run.output.includes(`ok   ${ORDER_PROBE}`) || failures.length === 1, run.output);
  assert.equal(run.status, failures.length ? 1 : 0, run.output);
  assert.match(run.output, new RegExp(`onboarding-exploratory-acceptance: \\d+ passed, ${failures.length} failed, \\d+ N-A\\.`));
}
// Identity-shaped fixture only. The child replaces fetch before importing the script.
const TOKEN = `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64')}.fixture.not-a-secret`;

function runScript(options: {
  staging?: boolean;
  args?: string[];
  guildId?: string;
  token?: string;
  now?: string;
  removeReplayGuard?: boolean;
  fixCatalogOrder?: boolean;
} = {}): { status: number | null; output: string } {
  const bootstrap = `
    import { registerHooks } from 'node:module';
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(url);
      const body = url.endsWith('/users/@me') ? { id: 'fixture', username: 'fixture' }
        : url.endsWith('/channels') ? [{ id: 'fixture', name: 'welcome', type: 0 }]
        : { id: ${JSON.stringify(TWO_STAGING_GUILD_ID)}, name: 'TWO Staging fixture' };
      return { status: 200, json: async () => body };
    };
    process.on('exit', () => console.log('MOCK_REQUESTS=' + requests.length));
    ${options.now ? `
      const RealDate = Date;
      const clock = RealDate.parse(${JSON.stringify(options.now)});
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [clock])); }
        static now() { return clock; }
      };
    ` : ''}
    ${options.removeReplayGuard ? `
      registerHooks({ load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (url !== ${JSON.stringify(STORE)}) return loaded;
        const source = String(loaded.source);
        const guard = 'return below !== null && atIso <= below ? null : rung;';
        if (source.split(guard).length !== 2) throw new Error('replay mutation anchor moved');
        return { ...loaded, source: source.replace(guard, 'return rung;') };
      } });
    ` : ''}
    ${options.fixCatalogOrder ? `
      registerHooks({ load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (url !== ${JSON.stringify(SESSION)}) return loaded;
        const source = String(loaded.source);
        const loop = 'for (const p of picks) {';
        if (source.split(loop).length !== 2) throw new Error('catalog-order fixture anchor moved');
        return { ...loaded, source: source.replace(loop, 'for (const p of catalog.filter(p => picks.includes(p))) {') };
      } });
    ` : ''}
    process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}, ...${JSON.stringify(options.args ?? (options.staging ? ['--staging'] : []))}];
    await import(${JSON.stringify(SCRIPT)});
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 20_000,
    // Do not inherit credentials or database URLs; every request is a local mock.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(options.guildId === undefined ? {} : { DISCORD_STAGING_GUILD_ID: options.guildId }),
      ...(options.token === undefined ? {} : { DISCORD_STAGING_BOT_TOKEN: options.token }),
    },
  });
  assert.ifError(run.error);
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

for (const args of [['--help'], ['-h'], ['--staging', '--help'], ['-h', '--staging']]) {
  test(`help ${args.join(' ')} exits zero before probes or staging identity checks`, () => {
    const run = runScript({ args });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /^Usage: node scripts\/onboarding-exploratory-acceptance\.ts/m);
    assert.doesNotMatch(run.output, /preconditions|==|FAIL |onboarding-exploratory-acceptance:/);
    assert.match(run.output, /MOCK_REQUESTS=0/);
  });
}

test('unknown arguments remain usage errors without running probes', () => {
  const run = runScript({ args: ['--unknown'] });
  assert.equal(run.status, 2, run.output);
  assert.match(run.output, /Usage:/);
  assert.doesNotMatch(run.output, /preconditions|==|FAIL /);
  assert.match(run.output, /MOCK_REQUESTS=0/);
});

for (const guildId of [undefined, '326474832151838730']) {
  test(`staging refuses ${guildId === undefined ? 'missing' : 'non-staging'} guild before any request`, () => {
    const run = runScript({ staging: true, token: TOKEN, guildId });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /FAIL staging guild guard/);
    assert.match(run.output, /MOCK_REQUESTS=0/);
  });
}

test('invalid staging token makes no request even with the accepted guild', () => {
  const run = runScript({ staging: true, token: 'invalid-fixture', guildId: TWO_STAGING_GUILD_ID });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /FAIL staging token belongs to the staging app/);
  assert.match(run.output, /MOCK_REQUESTS=0/);
});

test('accepted staging identity exercises all three read-only requests through mocks', () => {
  const run = runScript({ staging: true, token: TOKEN, guildId: TWO_STAGING_GUILD_ID });
  assertProbeOutcome(run);
  assert.match(run.output, /ok   staging guild reachable/);
  assert.match(run.output, /ok   staging has a #welcome channel/);
  assert.match(run.output, /MOCK_REQUESTS=3/);
});

for (const now of ['2026-09-26T12:00:00.000Z', '2030-01-01T00:00:00.000Z']) {
  test(`offline funnel controls its clock even when the ambient clock is ${now}`, () => {
    const run = runScript({ now });
    assertProbeOutcome(run);
    assert.match(run.output, /ok   invisible legacy fallback is withheld, not routed/);
    assert.match(run.output, /ok   dark pick routes to the visible hub, flagged degraded/);
    assert.match(run.output, /ok   join -> routed is 10s \(the under-60s claim shape\)/);
    assert.match(run.output, /ok   join -> first_message is 40s/);
    assert.match(run.output, /MOCK_REQUESTS=0/);
  });
}

test('a corrected catalog-order probe exits zero without breaking the mock assertions', () => {
  const run = runScript({ fixCatalogOrder: true, staging: true, token: TOKEN, guildId: TWO_STAGING_GUILD_ID });
  assertProbeOutcome(run);
  assert.equal(run.status, 0, run.output);
  assert.ok(run.output.includes(`ok   ${ORDER_PROBE}`), run.output);
  assert.match(run.output, /MOCK_REQUESTS=3/);
});

test('probe outcome assertions reject unrelated failures and incorrect exit codes', () => {
  const run = runScript();
  assertProbeOutcome(run);
  assert.throws(() => assertProbeOutcome({ ...run, output: `${run.output}\nFAIL unrelated probe  -  regression\n` }));
  assert.throws(() => assertProbeOutcome({ ...run, status: run.status === 0 ? 1 : 0 }));
  assert.throws(() => assertProbeOutcome({ ...run, status: null }));
});

test('exploratory replay probes fail if the timestamp guard is removed', () => {
  const run = runScript({ removeReplayGuard: true });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /FAIL first-message redelivery leaves the second rung empty/);
  assert.match(run.output, /FAIL second-message redelivery leaves the third rung empty/);
  assert.match(run.output, /MOCK_REQUESTS=0/);
});

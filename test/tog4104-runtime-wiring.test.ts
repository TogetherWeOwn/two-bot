import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Exact excerpts allow shallow/offline CI to execute the pinned startup, not
// the moving working tree. verify-runtime-source.mjs checks them against Git
// objects.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/tog4104-runtime-source.json', import.meta.url), 'utf8'));
assert.equal(fixture.revision, '7995b3fb13feda26ae35356bc5227c67870370c9');
const blocks = fixture.blocks;
for (const block of Object.values(blocks) as Array<{ code: string; sha256: string }>) {
  assert.equal(createHash('sha256').update(block.code).digest('hex'), block.sha256);
}
const js = (code: string) => stripTypeScriptTypes(code.replace(/^export /gm, ''));

async function startup(code: string) {
  const settings = { get() {}, async set() {} };
  const captured: any[] = [];
  const sentinel = class {};
  const sandbox = {
    internal: null,
    internalCfg: { enabled: new Set(['settings.get', 'settings.set']), keys: [] },
    cfg: { guildId: '1545644954272137297', discordToken: 'offline-sentinel' },
    settings, db: {}, expectedJoins: {},
    KeyRing: sentinel, DiscordActions: sentinel, InternalActionStore: sentinel,
    stagingRestartFetch: async () => { throw new Error('offline: no fetch'); },
    automationCfg: { enabled: false }, automationService: null, commandRegistry: null,
    moderationResolver: null, moderationService: null,
    startInternalActions: async (opts: unknown) => { captured.push(opts); return opts; },
  };
  await runInNewContext(`(async () => { ${js(code)} })()`, sandbox, { timeout: 1000 });
  assert.equal(captured.length, 1);
  return { opts: captured[0], settings };
}

// Execute the pinned defaults and assertAllowed implementation, not a copied
// predicate. Discord/DB constructors and unrelated moderation verbs are stubs;
// no listener, database or full application bootstrap is run by this witness.
const gate = runInNewContext([
  ...['actionError', 'implemented', 'needsStores', 'isImplemented', 'assertAllowed']
    .map((key) => js(blocks[key].code)),
  `(opts, action) => { ${js(blocks.serverGate.code)} }`,
].join('\n'), { MODERATION_ACTIONS: [] }, { timeout: 1000 });

const settingsRefusal = (error: any) => {
  assert.equal(error.code, 'action_not_allowed');
  assert.equal(error.logReason, 'action_needs_settings');
  return true;
};

test('TOG-4705 pinned startup passes settings, so both settings actions are allowed', async () => {
  const { opts, settings } = await startup(blocks.startup.code);
  assert.equal(opts.settings, settings);
  assert.ok(opts.store, 'durable action store is wired; it is not the settings dependency');
  for (const action of ['settings.get', 'settings.set']) {
    assert.ok(opts.enabled.has(action));
    assert.doesNotThrow(() => gate(opts, action));
  }
});

test('TOG-4705 control: removing settings from the pinned call re-opens the TOG-4104 denial', async () => {
  const original = blocks.startup.code;
  const unwired = original.replace('    settings,\n', '');
  assert.notEqual(unwired, original, 'control must remove the wired settings line');
  const { opts } = await startup(unwired);
  assert.equal(Object.hasOwn(opts, 'settings'), false);
  for (const action of ['settings.get', 'settings.set']) {
    assert.throws(() => gate(opts, action), settingsRefusal);
  }
});

test('TOG-4705 null settings, disabled actions and missing durable store still refuse', async () => {
  const { opts } = await startup(blocks.startup.code);
  for (const action of ['settings.get', 'settings.set']) {
    assert.throws(() => gate({ ...opts, settings: null }, action), settingsRefusal);
    assert.throws(() => gate({ ...opts, enabled: new Set() }, action),
      (error: any) => error.code === 'action_not_allowed' && error.logReason === 'action_disabled');
  }
  assert.throws(() => gate({ ...opts, store: null }, 'settings.set'),
    (error: any) => error.code === 'action_not_allowed' && error.logReason === 'action_needs_store');
});

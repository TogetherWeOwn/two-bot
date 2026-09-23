import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Exact excerpts allow shallow/offline CI to execute measured startup, not the
// moving working tree. verify-runtime-source.mjs checks them against Git objects.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/tog4104-runtime-source.json', import.meta.url), 'utf8'));
assert.equal(fixture.revision, 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90');
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
    automationCfg: { enabled: false }, automationService: null, commandRegistry: null,
    moderationResolver: null, moderationService: null,
    startInternalActions: async (opts: unknown) => { captured.push(opts); return opts; },
  };
  await runInNewContext(`(async () => { ${js(code)} })()`, sandbox, { timeout: 1000 });
  assert.equal(captured.length, 1);
  return { opts: captured[0], settings };
}

// Execute the measured defaults and assertAllowed implementation, not a copied
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

test('TOG-4104 measured startup options deny both settings actions despite enabled flags', async () => {
  const { opts } = await startup(blocks.startup.code);
  assert.equal(Object.hasOwn(opts, 'settings'), false);
  assert.ok(opts.store, 'durable action store is wired; it is not the missing dependency');
  for (const action of ['settings.get', 'settings.set']) {
    assert.ok(opts.enabled.has(action));
    assert.throws(() => gate(opts, action), settingsRefusal);
  }
});

test('TOG-4104 test-only wiring mutation changes the actual startup option and gate outcome', async () => {
  const original = blocks.startup.code;
  const mutated = original.replace('    expectedJoins,', '    settings,\n    expectedJoins,');
  assert.notEqual(mutated, original, 'mutation must affect the captured startup call');
  const { opts, settings } = await startup(mutated);
  assert.equal(opts.settings, settings);
  for (const action of ['settings.get', 'settings.set']) {
    assert.doesNotThrow(() => gate(opts, action));
    assert.throws(() => gate({ ...opts, settings: null }, action), settingsRefusal);
    assert.throws(() => gate({ ...opts, enabled: new Set() }, action),
      (error: any) => error.code === 'action_not_allowed' && error.logReason === 'action_disabled');
  }
  assert.throws(() => gate({ ...opts, store: null }, 'settings.set'),
    (error: any) => error.code === 'action_not_allowed' && error.logReason === 'action_needs_store');
});

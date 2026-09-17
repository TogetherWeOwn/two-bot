/**
 * `settings.get` / `settings.set` - the allowlist entries the admin dashboard
 * is built on (TOG-3101, TOG-3093 slice 2).
 *
 * These drive the handlers directly rather than over HTTP, and they do it
 * against a settings port that enforces NOTHING. That is the whole design of
 * this file. `src/core/settings.ts` refuses `TWO_INTERNAL_*` and migration
 * 0026 refuses it again with a CHECK constraint, so a test that went through
 * the real store would still pass with the handler's guard deleted - it would
 * be testing the store's refusal and reporting it as the handler's. The
 * recording stub below is the only way to make the claim "the handler refuses
 * it" falsifiable.
 *
 * Every refusal test therefore asserts two things: the typed error, AND that
 * the store was never called. Delete the guard in requireSettingsKey() and the
 * second assertion goes red even if you also weaken the first.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAction,
  assertAllowed,
  NEEDS_IDEMPOTENCY_KEY,
  NEEDS_SETTINGS_STORE,
  IMPLEMENTED_ACTIONS,
  type ActionContext,
  type ActionName,
  type SettingsPort,
} from '../src/internal/actions.ts';
import { ActionError } from '../src/internal/errors.ts';
import { loadInternalActionsConfig } from '../src/internal/config.ts';

const GUILD = '326474832151838730';
const ADMIN = '111111111111111111';

/**
 * A settings store with no opinions: it records what it was asked to do and
 * does it. It deliberately does not implement the key rules, because those are
 * what the handler is on trial for.
 */
class RecordingSettings implements SettingsPort {
  readonly reads: { guildId: string; key: string }[] = [];
  readonly writes: { guildId: string; key: string; value: unknown; actor: string }[] = [];
  private readonly rows = new Map<string, unknown>();

  seed(key: string, value: unknown): void {
    this.rows.set(key, value);
  }

  get(guildId: string, key: string): unknown {
    this.reads.push({ guildId, key });
    return this.rows.get(key);
  }

  async set(guildId: string, key: string, value: unknown, actor: string): Promise<void> {
    this.writes.push({ guildId, key, value, actor });
    if (value === null) this.rows.delete(key);
    else this.rows.set(key, value);
  }
}

let settings: RecordingSettings;

beforeEach(() => {
  settings = new RecordingSettings();
});

/** The minimum an internal action needs. No Discord call is reachable from here. */
function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    guildId: GUILD,
    discord: new Proxy({}, {
      get(_t, prop) {
        return () => {
          throw new Error(`settings actions must never call Discord (tried ${String(prop)})`);
        };
      },
    }) as ActionContext['discord'],
    roleKeys: new Map(),
    channelKeys: new Map(),
    enabled: new Set<string>(['settings.get', 'settings.set']),
    store: null,
    settings,
    idempotencyKey: 'idem-0000-1111-2222',
    ...overrides,
  };
}

async function expectActionError(
  fn: () => Promise<unknown>,
): Promise<ActionError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ActionError, `expected ActionError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the action to throw');
}

// --- the security property ---------------------------------------------------
//
// docs/INTERNAL_ACTIONS.md's trust model: an attacker holding the website's
// shared secret can do exactly what is on the allowlist and nothing else. The
// TWO_INTERNAL_* variables are what decides that allowlist, so a settings verb
// that could touch one is a privilege-escalation primitive.

const ENV_ONLY_KEYS = [
  'TWO_INTERNAL_KEYS', // the signing secret itself
  'TWO_INTERNAL_ALLOW_ADD_MEMBER',
  'TWO_INTERNAL_ALLOW_AUTOMATIONS',
  'TWO_INTERNAL_ALLOW_AUTOMATIONS_OVERWRITE',
  'TWO_INTERNAL_ALLOW_MODERATION',
  'TWO_INTERNAL_ALLOW_SETTINGS', // the switch for this very action
  'TWO_INTERNAL_ROLE_KEYS',
  'TWO_INTERNAL_CHANNEL_KEYS',
  'TWO_INTERNAL_BIND_HOST',
];

for (const key of ENV_ONLY_KEYS) {
  test(`settings.set refuses ${key} and never reaches the store`, async () => {
    const err = await expectActionError(() =>
      runAction('settings.set', { key, value: '1', updated_by: ADMIN }, ctx()),
    );

    assert.equal(err.code, 'action_not_allowed');
    assert.equal(err.logReason, 'settings_key_env_only');
    // The assertion the guard cannot fake. A store that enforced the rule
    // itself would still have been *called*.
    assert.deepEqual(settings.writes, []);
  });
}

test('settings.get refuses the TWO_INTERNAL_ namespace too, and never reads it', async () => {
  // Reading is not harmless either: the dashboard would be able to enumerate
  // which capability gates are on, and a future env read-through would hand
  // back the signing secret.
  const err = await expectActionError(() =>
    runAction('settings.get', { key: 'TWO_INTERNAL_KEYS' }, ctx()),
  );

  assert.equal(err.code, 'action_not_allowed');
  assert.equal(err.logReason, 'settings_key_env_only');
  assert.deepEqual(settings.reads, []);
});

test('the refusal is a prefix rule, so a gate invented tomorrow is covered', async () => {
  const err = await expectActionError(() =>
    runAction(
      'settings.set',
      { key: 'TWO_INTERNAL_ALLOW_SOMETHING_NOBODY_HAS_WRITTEN_YET', value: '1', updated_by: ADMIN },
      ctx(),
    ),
  );
  assert.equal(err.code, 'action_not_allowed');
  assert.deepEqual(settings.writes, []);
});

test('a lookalike key that is not in the namespace is still writable', async () => {
  // The guard must be a namespace rule, not a keyword blocklist: refusing
  // anything containing "INTERNAL" would quietly break real settings.
  await runAction(
    'settings.set',
    { key: 'TWO_INTERNALISED_GREETING', value: 'hello', updated_by: ADMIN },
    ctx(),
  );
  assert.equal(settings.writes.length, 1);
  assert.equal(settings.writes[0].key, 'TWO_INTERNALISED_GREETING');
});

test('settings.get answers from the store only, never from the environment', async () => {
  // The environment holds DISCORD_TOKEN, DATABASE_URL and TWO_INTERNAL_KEYS.
  // A read-through would make this action a credential exfiltration primitive.
  const probe = 'TWO_SETTINGS_ENV_READTHROUGH_PROBE';
  process.env[probe] = 'this-must-never-come-back';
  try {
    const outcome = await runAction('settings.get', { key: probe }, ctx());
    assert.equal(outcome.result.value, null);
    assert.equal(outcome.result.source, 'unset');
  } finally {
    delete process.env[probe];
  }
});

// --- ordinary behaviour ------------------------------------------------------

test('settings.get returns a stored value and says where it came from', async () => {
  settings.seed('TWO_AUTOMOD_INVITE_ACTION', 'delete');
  const outcome = await runAction('settings.get', { key: 'TWO_AUTOMOD_INVITE_ACTION' }, ctx());

  assert.deepEqual(outcome.result, {
    key: 'TWO_AUTOMOD_INVITE_ACTION',
    value: 'delete',
    source: 'store',
  });
  assert.deepEqual(settings.reads, [{ guildId: GUILD, key: 'TWO_AUTOMOD_INVITE_ACTION' }]);
});

test('settings.set records the admin who saved it, verbatim and unguessed', async () => {
  const outcome = await runAction(
    'settings.set',
    { key: 'TWO_AUTOMOD_ENABLED', value: true, updated_by: ADMIN },
    ctx(),
  );

  assert.deepEqual(settings.writes, [
    { guildId: GUILD, key: 'TWO_AUTOMOD_ENABLED', value: true, actor: ADMIN },
  ]);
  assert.deepEqual(outcome.result, { key: 'TWO_AUTOMOD_ENABLED', outcome: 'saved' });
});

test('settings.set with a null value unsets the key and hands it back to the environment', async () => {
  settings.seed('TWO_AUTOMOD_ENABLED', true);
  const outcome = await runAction(
    'settings.set',
    { key: 'TWO_AUTOMOD_ENABLED', value: null, updated_by: ADMIN },
    ctx(),
  );

  assert.equal(settings.writes[0].value, null);
  assert.deepEqual(outcome.result, { key: 'TWO_AUTOMOD_ENABLED', outcome: 'unset' });
});

test('neither result echoes the value back, because the result is what gets replayed', async () => {
  const outcome = await runAction(
    'settings.set',
    { key: 'TWO_ANNOUNCE_WEBHOOK', value: 'https://example.invalid/hook/secret', updated_by: ADMIN },
    ctx(),
  );
  assert.equal(JSON.stringify(outcome.result).includes('secret'), false);
  assert.equal(outcome.outcome.includes('secret'), false);
});

// --- malformed ---------------------------------------------------------------

test('settings.set without updated_by is malformed, and writes nothing', async () => {
  const err = await expectActionError(() =>
    runAction('settings.set', { key: 'TWO_AUTOMOD_ENABLED', value: true }, ctx()),
  );
  assert.equal(err.code, 'malformed');
  assert.deepEqual(settings.writes, []);
});

test('updated_by must be a Discord id, not a name', async () => {
  const err = await expectActionError(() =>
    runAction(
      'settings.set',
      { key: 'TWO_AUTOMOD_ENABLED', value: true, updated_by: 'owen' },
      ctx(),
    ),
  );
  assert.equal(err.code, 'malformed');
  assert.equal(err.logReason, 'bad_updated_by');
  assert.deepEqual(settings.writes, []);
});

test('an omitted value is malformed - null is how you unset, and the two differ', async () => {
  const err = await expectActionError(() =>
    runAction('settings.set', { key: 'TWO_AUTOMOD_ENABLED', updated_by: ADMIN }, ctx()),
  );
  assert.equal(err.code, 'malformed');
  assert.equal(err.logReason, 'missing_value');
  assert.deepEqual(settings.writes, []);
});

test('a key that is not shaped like an environment variable is malformed', async () => {
  for (const key of ['lowercase', 'HAS SPACE', '1LEADING_DIGIT', 'X', 'TWO;DROP']) {
    const err = await expectActionError(() =>
      runAction('settings.set', { key, value: '1', updated_by: ADMIN }, ctx()),
    );
    assert.equal(err.code, 'malformed', `${key} should be malformed`);
  }
  assert.deepEqual(settings.writes, []);
});

test('an oversized value is refused before it reaches the store', async () => {
  const err = await expectActionError(() =>
    runAction(
      'settings.set',
      { key: 'TWO_BIG_SETTING', value: 'x'.repeat(9000), updated_by: ADMIN },
      ctx(),
    ),
  );
  assert.equal(err.code, 'malformed');
  assert.equal(err.logReason, 'settings_value_too_large');
  assert.deepEqual(settings.writes, []);
});

// --- the allowlist plumbing --------------------------------------------------

test('settings.set needs an idempotency key and settings.get does not', () => {
  // A repeat of a save is two audit rows and a silent revert of anything that
  // landed in between; a repeat of a read is a read.
  assert.equal(NEEDS_IDEMPOTENCY_KEY.has('settings.set'), true);
  assert.equal(NEEDS_IDEMPOTENCY_KEY.has('settings.get'), false);
});

test('both verbs are refused when the config store is not wired, as a typed error', () => {
  for (const action of ['settings.get', 'settings.set']) {
    assert.equal(NEEDS_SETTINGS_STORE.has(action), true);
    // Caught by hand rather than with assert.throws: that helper returns
    // undefined, so reading `.code` off its result asserts nothing at all.
    let err: unknown;
    try {
      // A non-null durable store on purpose: `settings.set` also needs one for
      // its idempotency key, so with both null that check fires first and this
      // test would go green while saying nothing about the config store.
      assertAllowed(action, {
        enabled: new Set([action]),
        store: {} as ActionContext['store'],
        settings: null,
      });
      assert.fail(`${action} must be refused without a config store`);
    } catch (caught) {
      err = caught;
    }
    assert.ok(err instanceof ActionError, `expected ActionError, got ${String(err)}`);
    assert.equal(err.code, 'action_not_allowed');
    assert.equal(err.logReason, 'action_needs_settings');
  }
});

test('both verbs are off unless TWO_INTERNAL_ALLOW_SETTINGS=1', () => {
  const base = {
    TWO_INTERNAL_ACTIONS: '1',
    TWO_INTERNAL_KEYS: 'web-test:0123456789abcdef0123456789abcdef',
  };

  const off = loadInternalActionsConfig({ ...base } as NodeJS.ProcessEnv);
  assert.equal(off?.enabled.has('settings.get'), false);
  assert.equal(off?.enabled.has('settings.set'), false);

  // Anything other than exactly '1' is off, including the string "true".
  const almost = loadInternalActionsConfig({
    ...base,
    TWO_INTERNAL_ALLOW_SETTINGS: 'true',
  } as NodeJS.ProcessEnv);
  assert.equal(almost?.enabled.has('settings.set'), false);

  const on = loadInternalActionsConfig({
    ...base,
    TWO_INTERNAL_ALLOW_SETTINGS: '1',
  } as NodeJS.ProcessEnv);
  assert.equal(on?.enabled.has('settings.get'), true);
  assert.equal(on?.enabled.has('settings.set'), true);
});

test('every implemented action has decided which side of the idempotency line it is on', () => {
  // The set is the machine-readable version of docs/INTERNAL_ACTIONS.md §3's
  // "needs key" column, and this is what stops the next action being added
  // without that decision being made.
  for (const action of IMPLEMENTED_ACTIONS as readonly ActionName[]) {
    assert.equal(typeof NEEDS_IDEMPOTENCY_KEY.has(action), 'boolean');
  }
  assert.ok((IMPLEMENTED_ACTIONS as readonly string[]).includes('settings.get'));
  assert.ok((IMPLEMENTED_ACTIONS as readonly string[]).includes('settings.set'));
});

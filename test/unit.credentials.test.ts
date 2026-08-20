/**
 * The token has to keep arriving whichever way the box provides it. These tests
 * pin the precedence, because getting it wrong is silent: a stale environment
 * variable shadowing a rotated credential would keep the bot running on the old
 * token until Discord revoked it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSecret, credentialSource } from '../src/core/credentials.ts';
import { loadInternalActionsConfig } from '../src/internal/config.ts';

function credDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'two-creds-'));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o400);
  }
  return dir;
}

test('credential file wins over the environment', () => {
  const dir = credDir({ discord_token: 'from-credential' });
  const v = readSecret('discord_token', ['DISCORD_TOKEN'], {
    dir,
    env: { DISCORD_TOKEN: 'from-env' },
  });
  assert.equal(v, 'from-credential');
});

test('trailing newline from an editor is stripped', () => {
  const dir = credDir({ discord_token: 'tok\n' });
  assert.equal(readSecret('discord_token', [], { dir, env: {} }), 'tok');
});

test('falls back to the environment when the credential is absent', () => {
  const dir = credDir({});
  assert.equal(
    readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN'], {
      dir,
      env: { DISCORD_TOKEN: 'from-env' },
    }),
    'from-env',
  );
});

test('env names are tried in order', () => {
  assert.equal(
    readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN'], {
      dir: null,
      env: { DISCORD_BOT_TOKEN: 'first', DISCORD_TOKEN: 'second' },
    }),
    'first',
  );
});

test('an empty credential file falls through rather than yielding an empty token', () => {
  const dir = credDir({ discord_token: '   \n' });
  assert.equal(
    readSecret('discord_token', ['DISCORD_TOKEN'], { dir, env: { DISCORD_TOKEN: 'from-env' } }),
    'from-env',
  );
});

test('nothing set anywhere is null, not an empty string', () => {
  assert.equal(readSecret('discord_token', ['DISCORD_TOKEN'], { dir: null, env: {} }), null);
});

test('no CREDENTIALS_DIRECTORY means plain environment lookup', () => {
  const src = credentialSource({ DISCORD_TOKEN: 'dev' });
  assert.equal(src.dir, null);
  assert.equal(readSecret('discord_token', ['DISCORD_TOKEN'], src), 'dev');
});

test('internal actions keys load from a credential', () => {
  const dir = credDir({ internal_keys: 'web-1:0123456789abcdef0123456789abcdef\n' });
  const cfg = loadInternalActionsConfig({
    TWO_INTERNAL_ACTIONS: '1',
    CREDENTIALS_DIRECTORY: dir,
  } as NodeJS.ProcessEnv);
  assert.ok(cfg);
  assert.equal(cfg.keys.length, 1);
  assert.equal(cfg.keys[0].id, 'web-1');
});

test('internal actions still accept TWO_INTERNAL_KEYS from the environment', () => {
  const cfg = loadInternalActionsConfig({
    TWO_INTERNAL_ACTIONS: '1',
    TWO_INTERNAL_KEYS: 'web-1:0123456789abcdef0123456789abcdef',
  } as NodeJS.ProcessEnv);
  assert.ok(cfg);
  assert.equal(cfg.keys[0].id, 'web-1');
});

test('internal actions with no keys at all still refuses to start', () => {
  assert.throws(
    () => loadInternalActionsConfig({ TWO_INTERNAL_ACTIONS: '1' } as NodeJS.ProcessEnv),
    /internal_keys|TWO_INTERNAL_KEYS/,
  );
});

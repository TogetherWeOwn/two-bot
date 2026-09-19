/**
 * TOG-3183 close, option 1: `loadInternalActionsConfig()` reads the real
 * environment and nothing else.
 *
 * Since TOG-3100 `loadConfig()` reads `guild_settings` first. If the same
 * snapshot were ever threaded into the internal-actions config, a website that
 * already has `TWO_INTERNAL_ALLOW_MODERATION=1` - a plausible staged rollout -
 * could turn on nine moderation verbs by saving `TWO_MODERATION`, which carries
 * no `TWO_INTERNAL_` prefix and so was never covered by the prefix refusal.
 *
 * The catalog refuses to store that key at all, and two CHECK constraints say
 * so in the schema. This file defends the other end: that there is no seam to
 * thread a snapshot through in the first place. Deleting either defence should
 * leave the other one failing loudly, which is the point of having both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadInternalActionsConfig } from '../src/internal/config.ts';
import { storeFirst } from '../src/core/config.ts';

function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('no call site passes an argument to loadInternalActionsConfig', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Skip the declaration itself - its `env` parameter is the thing under
      // test, not a violation - and skip prose in comments, which would
      // otherwise let this guard match its own explanation.
      if (line.includes('export function loadInternalActionsConfig')) return;
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      const m = code.match(/loadInternalActionsConfig\(([^)]*)\)/);
      if (!m) return;
      if (m[1].trim() !== '') offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'loadInternalActionsConfig() must be called with no argument in src/, so it ' +
      'reads process.env. Passing a SettingsStore snapshot would let a stored ' +
      'TWO_MODERATION widen the internal-actions allowlist (TOG-3183).\n' +
      offenders.join('\n'),
  );
});

test('the declaration still defaults to process.env', () => {
  // If somebody changes the default the call-site guard above goes vacuous:
  // every call site would still pass nothing, and still get the wrong source.
  const src = readFileSync('src/internal/config.ts', 'utf8');
  assert.match(
    src,
    /export function loadInternalActionsConfig\(\s*env: NodeJS\.ProcessEnv = process\.env/,
    'the default source must be process.env',
  );
});

test('a stored TWO_MODERATION cannot reach the allowlist', () => {
  const saved = {
    actions: process.env.TWO_INTERNAL_ACTIONS,
    keys: process.env.TWO_INTERNAL_KEYS,
    allow: process.env.TWO_INTERNAL_ALLOW_MODERATION,
    moderation: process.env.TWO_MODERATION,
  };
  try {
    // The staged-rollout state the finding describes: the internal gate is on,
    // the co-gate is not set in the environment.
    process.env.TWO_INTERNAL_ACTIONS = '1';
    process.env.TWO_INTERNAL_KEYS = 'k1:0123456789abcdef0123456789abcdef';
    process.env.TWO_INTERNAL_ALLOW_MODERATION = '1';
    delete process.env.TWO_MODERATION;

    const cfg = loadInternalActionsConfig();
    assert.ok(cfg, 'endpoint should be enabled for this test to mean anything');
    assert.equal(
      cfg.enabled.has('moderation.ban'),
      false,
      'moderation verbs must stay off while TWO_MODERATION is unset in the environment',
    );

    // And the fourth layer: even a hand-built store-first source refuses to
    // serve this key from the store, so the value the config would see is the
    // environment's absence rather than the stored '1'.
    const src = storeFirst(new Map([['TWO_MODERATION', '1']]));
    assert.equal(src.get('TWO_MODERATION'), undefined);
  } finally {
    for (const [k, v] of [
      ['TWO_INTERNAL_ACTIONS', saved.actions],
      ['TWO_INTERNAL_KEYS', saved.keys],
      ['TWO_INTERNAL_ALLOW_MODERATION', saved.allow],
      ['TWO_MODERATION', saved.moderation],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/**
 * The catalog is only a security boundary while it matches the code.
 *
 * So the census test fails in both directions: a variable `src/` reads that
 * nobody classified, and a classified name `src/` no longer reads. A one-sided
 * check would let the set drift open - somebody adds `TWO_INTERNAL_ALLOW_X`'s
 * non-prefixed cousin, never touches this file, and the only thing standing
 * between it and `guild_settings` is that `classifyKey()` happens to return
 * undefined. That is the right answer, but nobody would have decided it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV_ONLY_KEY_PREFIXES,
  HOT_WIRED,
  SECRET_NAMES_NOT_IN_SRC_GREP,
  SETTING_CLASSES,
  classifyKey,
  isEnvOnlyKey,
} from '../src/core/settingsCatalog.ts';

/**
 * The TOG-3100 census, as code rather than as a shell pipeline in a card.
 *
 * Two read shapes, because this card created the second one. Before it, every
 * config read in `src/` was a property access on the environment and the card's
 * `grep -rhoE '\benv\.[A-Z_]+'` found all of them. After it, the storable keys
 * are read out of a `ConfigSource` by name - `src.get('X')`, or the `str()` and
 * `list()` helpers that wrap it - and the property access is gone. A census
 * that only knew the old shape would report all 24 converted keys as dead and,
 * worse, would stop noticing a *new* one, which is the direction that matters.
 */
const READ_SHAPES = [
  /** Direct environment read, anywhere in src/. */
  /\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g,
  /** Read through the store-first source in loadConfig(). */
  /\b(?:src\.get|str|list)\(\s*'([A-Z][A-Z0-9_]+)'/g,
];

function envNamesReadBySrc(dir = 'src'): Set<string> {
  const found = new Set<string>();

  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8');
        for (const shape of READ_SHAPES) {
          for (const m of text.matchAll(shape)) found.add(m[1]);
        }
      }
    }
  };

  walk(dir);
  return found;
}

test('every env var src/ reads is classified', () => {
  const unclassified = [...envNamesReadBySrc()].filter((n) => classifyKey(n) === undefined).sort();
  assert.deepEqual(
    unclassified,
    [],
    `Unclassified environment variables. Add them to src/core/settingsCatalog.ts ` +
      `with the reason, then decide hot / cold / env_only: ${unclassified.join(', ')}`,
  );
});

test('every classified name is still read by src/, or is a documented grep blind spot', () => {
  const live = envNamesReadBySrc();
  const exempt = new Set<string>(SECRET_NAMES_NOT_IN_SRC_GREP);
  const stale = Object.keys(SETTING_CLASSES)
    .filter((n) => !live.has(n) && !exempt.has(n))
    .sort();
  assert.deepEqual(
    stale,
    [],
    `Classified but no longer read by src/. Delete them, or add them to ` +
      `SECRET_NAMES_NOT_IN_SRC_GREP with the readSecret() call site: ${stale.join(', ')}`,
  );
});

test('the ConfigSource read shape is load-bearing, not decoration', () => {
  // Without this, the second pattern could stop matching - somebody renames
  // `str()`, or drops the quotes for a constant - and the census would quietly
  // shrink to the pre-TOG-3100 surface. The two tests above would still pass,
  // because a name that is read by nothing and classified by nobody is invisible
  // to both. This asserts the shape actually finds keys the old grep cannot.
  const envShapeOnly = new Set<string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(READ_SHAPES[0])) envShapeOnly.add(m[1]);
      }
    }
  };
  walk('src');

  const onlyViaSource = [...envNamesReadBySrc()].filter((n) => !envShapeOnly.has(n));
  assert.ok(
    onlyViaSource.length > 0,
    'no key is read through a ConfigSource - did loadConfig() stop being store-first?',
  );
  // TWO_RAID_JOIN_THRESHOLD is the key the card's staging proof hot-reloads, so
  // its read path is the one thing here that must not silently revert.
  assert.ok(
    onlyViaSource.includes('TWO_RAID_JOIN_THRESHOLD'),
    'TWO_RAID_JOIN_THRESHOLD must be read through the store-first source, not process.env',
  );
});

test('the readSecret blind spot is real: those names are invisible to the census', () => {
  // If one of these ever starts being read as `process.env.X` the exemption
  // above stops being load-bearing and should be deleted rather than left to
  // rot into a permanent excuse.
  const live = envNamesReadBySrc();
  for (const name of SECRET_NAMES_NOT_IN_SRC_GREP) {
    assert.equal(live.has(name), false, `${name} is now greppable; drop its exemption`);
  }
});

test('all three secrets the census cannot see are env_only', () => {
  for (const name of SECRET_NAMES_NOT_IN_SRC_GREP) {
    assert.equal(classifyKey(name), 'env_only', name);
    assert.equal(isEnvOnlyKey(name), true, name);
  }
});

test('TOG-3183: the capability gates outside the TWO_INTERNAL_ namespace are refused', () => {
  // The finding, as an executable claim. Each of these was stored through the
  // live handler in the reviewer's probe before this card.
  for (const name of [
    'TWO_MODERATION', // src/internal/config.ts, co-gate on 9 moderation verbs
    'TWO_ONBOARDING_MODE', // src/index.ts -> actionsForOnboardingMode()
    'DISCORD_TOKEN',
    'TWO_DATABASE_URL',
    'TWO_MODERATION_AUDIT_SECRET',
  ]) {
    assert.equal(isEnvOnlyKey(name), true, `${name} must not be storable`);
    assert.equal(
      ENV_ONLY_KEY_PREFIXES.some((p) => name.startsWith(p)),
      false,
      `${name} is the interesting case precisely because the prefix misses it`,
    );
  }
});

test('unknown keys are refused, not allowed', () => {
  assert.equal(classifyKey('TWO_SOMETHING_INVENTED_TOMORROW'), undefined);
  assert.equal(isEnvOnlyKey('TWO_SOMETHING_INVENTED_TOMORROW'), true);
  assert.equal(isEnvOnlyKey(''), true);
});

test('the TWO_INTERNAL_ prefix still refuses a name that is not in the table', () => {
  // The prefix has to keep working on its own: that is what protects the next
  // gate added inside the namespace before anybody edits the catalog.
  assert.equal(classifyKey('TWO_INTERNAL_ALLOW_SOMETHING_NEW'), undefined);
  assert.equal(isEnvOnlyKey('TWO_INTERNAL_ALLOW_SOMETHING_NEW'), true);
});

test('TWO_AUTOMOD stays cold and storable, deliberately', () => {
  // The TOG-3183 comment lists TWO_AUTOMOD alongside the keys that should be
  // refused. It is the one item on that list this card does not move: it gates
  // no internal-actions verb (it appears in src/automod, src/discord/client.ts
  // and src/index.ts, never in src/internal/config.ts), and it is the automod
  // master switch the owner is supposed to be able to turn off from the
  // dashboard. Cold, because the client's cache policy is fixed at construction.
  assert.equal(classifyKey('TWO_AUTOMOD'), 'cold');
  assert.equal(isEnvOnlyKey('TWO_AUTOMOD'), false);
});

test('hot-wired keys are a subset of hot keys', () => {
  for (const name of HOT_WIRED) {
    assert.equal(classifyKey(name), 'hot', `${name} is wired live but not classed hot`);
  }
});

test('no key is both prefix-refused and classed storable', () => {
  for (const [name, cls] of Object.entries(SETTING_CLASSES)) {
    if (ENV_ONLY_KEY_PREFIXES.some((p) => name.startsWith(p))) {
      assert.equal(cls, 'env_only', `${name} carries an env-only prefix but is classed ${cls}`);
    }
  }
});

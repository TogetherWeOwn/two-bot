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
import { HOT_WIRED_FIELDS, type Config } from '../src/core/config.ts';

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

test('all secrets the census cannot see are env_only', () => {
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

/**
 * The files that decide the internal-actions allowlist, and the gate names each
 * one is *handed* rather than reads for itself.
 *
 * The test below derives the key half of this - which files decide the
 * allowlist, and which environment variables they read - and set-compares the
 * file list against these keys in both directions. Adding a file that builds or
 * narrows a `Set<ActionName>` fails the suite until somebody comes here and says
 * what gates it; deleting one fails until the entry goes. That is the property
 * the hardcoded list in the TOG-3183 test above does not have.
 *
 * An empty array means "reads its own gates", so the derivation covers it and
 * there is nothing to declare. A non-empty array is a gate this file acts on but
 * cannot be seen to read, because it arrives as a parameter - the one shape a
 * file-local census structurally cannot find.
 */
const ALLOWLIST_GATE_SOURCES: Readonly<Record<string, readonly string[]>> = {
  // Defines the verb surface; reads no environment of its own.
  'src/internal/actions.ts': [],
  // Builds `enabled`. Every gate it consults is an `env.X` read, so derived.
  'src/internal/config.ts': [],
  // Narrows `enabled`, but the mode is threaded in from src/index.ts:599.
  'src/onboarding/mode.ts': ['TWO_ONBOARDING_MODE'],
};

/** Every `src/` file that builds or narrows the internal-actions allowlist. */
function allowlistDecidingFiles(dir = 'src'): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      // \b excludes ModerationActionName, which is a different type in a
      // different subsystem and has nothing to do with the website allowlist.
      else if (p.endsWith('.ts') && /\bActionName\b/.test(readFileSync(p, 'utf8'))) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

/** The environment names read inside one file, in either read shape. */
function envNamesReadByFile(path: string): Set<string> {
  const text = readFileSync(path, 'utf8');
  const found = new Set<string>();
  for (const shape of READ_SHAPES) for (const m of text.matchAll(shape)) found.add(m[1]);
  return found;
}

test('TOG-3217: the allowlist-deciding file set is declared, both directions', () => {
  // Vacuity first. A derivation that finds nothing would make every assertion
  // below pass over an empty set, which is the failure mode this whole test is
  // meant to close - so it has to be impossible rather than merely unlikely.
  const derived = allowlistDecidingFiles();
  assert.ok(derived.length > 0, 'no file decides the allowlist - did ActionName get renamed?');
  assert.deepEqual(
    derived,
    Object.keys(ALLOWLIST_GATE_SOURCES).sort(),
    'a file that builds or narrows Set<ActionName> is not declared in ' +
      'ALLOWLIST_GATE_SOURCES (or a declared one is gone). Declare which ' +
      'environment variables gate it; they must all be env_only.',
  );
});

test('TOG-3217: every gate an allowlist-deciding file reads is env_only', () => {
  // The finding this closes: the census tests require a name be *classified*,
  // not classified *correctly*. The reviewer added TWO_FAKE_ESCALATION_GATE to
  // src/internal/config.ts, classed it `hot`, and all fifteen tests still
  // passed. This one derives the gate set from the code that gates, so a new
  // gate is caught by being in the wrong class rather than by being unlisted.
  const gates = new Set<string>();
  for (const [path, threaded] of Object.entries(ALLOWLIST_GATE_SOURCES)) {
    for (const name of envNamesReadByFile(path)) gates.add(name);
    for (const name of threaded) gates.add(name);
  }

  // The derivation has to see the case the prefix misses, or it is only
  // re-proving that TWO_INTERNAL_* starts with TWO_INTERNAL_.
  assert.ok(
    gates.has('TWO_MODERATION'),
    'the derivation no longer sees TWO_MODERATION - the one gate that is ' +
      'inside the blast radius and outside the namespace',
  );
  assert.ok(gates.has('TWO_ONBOARDING_MODE'), 'the threaded-gate declaration stopped contributing');

  const misclassified = [...gates]
    .filter((name) => classifyKey(name) !== 'env_only')
    .sort();
  assert.deepEqual(
    misclassified,
    [],
    `These decide what the website may make the bot do, so they must be ` +
      `env_only in src/core/settingsCatalog.ts - a storable one is the ` +
      `privilege escalation ADR TOG-3093 2.4 exists to prevent: ` +
      `${misclassified.join(', ')}`,
  );

  // classifyKey() alone would accept `undefined`, which isEnvOnlyKey() refuses
  // for a different reason. Assert the enforced predicate too, so neither can
  // drift away from the other without a failure.
  for (const name of gates) assert.equal(isEnvOnlyKey(name), true, `${name} must not be storable`);
});

test('TOG-3217: src/index.ts narrows the allowlist only through the declared call', () => {
  // The residual gap in the derivation above: src/index.ts mutates
  // internalCfg.enabled without ever naming ActionName, so it is not in the
  // derived file set. A gate added *there* - `if (env.X === '1')
  // internalCfg.enabled.add(...)` - would escape both. Pin the site instead.
  const all = readFileSync('src/index.ts', 'utf8')
    .split('\n')
    .filter((l) => l.includes('internalCfg.enabled'));
  assert.ok(all.length > 0, 'internalCfg.enabled is gone from src/index.ts - repoint this test');

  // Reads are fine and there is one: `enabled: internalCfg.enabled` hands the
  // finished set to startInternalActions(). Only writes can widen it.
  const lines = all.filter((l) => /internalCfg\.enabled\s*(?:=[^=]|\.(?:add|delete|clear)\()/.test(l));
  assert.ok(
    lines.length > 0,
    'no write to internalCfg.enabled in src/index.ts - the narrowing call is ' +
      'gone, or was renamed past this pattern. Repoint the test rather than ' +
      'letting it pass over nothing.',
  );
  for (const line of lines) {
    assert.match(
      line,
      /internalCfg\.enabled = actionsForOnboardingMode\(cfg\.onboardingMode, internalCfg\.enabled\)/,
      `src/index.ts touches the internal-actions allowlist outside the one ` +
        `declared narrowing call. Whatever gates it is an env_only key, and it ` +
        `belongs in a file the ALLOWLIST_GATE_SOURCES census can see: ${line.trim()}`,
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

test('every hot-wired key has a Config field the reload line can name, and vice versa', () => {
  // Both directions, because the two failures are different and neither is
  // visible from the other side. A key wired into a live consumer but missing
  // from HOT_WIRED_FIELDS changes the bot's behaviour with nothing in the log
  // to say so, which is the state TOG-3100's staging proof exists to rule out.
  // A key in HOT_WIRED_FIELDS but not in HOT_WIRED logs a change that no
  // consumer has picked up - a line that reads like proof and is not.
  const wired = [...HOT_WIRED].sort();
  const logged = Object.keys(HOT_WIRED_FIELDS).sort();
  assert.deepEqual(logged, wired);

  // And the accessors have to read different fields: two entries returning the
  // same value would satisfy the parity check above while making one of the two
  // log lines a lie.
  const a = { raidJoinThreshold: 5, raidWindowSeconds: 60 } as Config;
  const b = { raidJoinThreshold: 3, raidWindowSeconds: 60 } as Config;
  assert.notEqual(
    HOT_WIRED_FIELDS.TWO_RAID_JOIN_THRESHOLD(a),
    HOT_WIRED_FIELDS.TWO_RAID_JOIN_THRESHOLD(b),
  );
  assert.equal(
    HOT_WIRED_FIELDS.TWO_RAID_WINDOW_SECONDS(a),
    HOT_WIRED_FIELDS.TWO_RAID_WINDOW_SECONDS(b),
  );
});

test('TOG-3217: env-only constraints and the catalog refuse the same names', () => {
  // migrations/0027_guild_settings_env_only.sql says in its header that this
  // test exists and fails on divergence. Until TOG-3217 it did not - the claim
  // was true of nothing. The two lists are the application half and the schema
  // half of one rule, and a name added to the catalog but not the constraint is
  // refused by the handler and accepted by psql, which is precisely the case
  // the constraint was added for.
  const list = [
    'migrations/0027_guild_settings_env_only.sql',
    'migrations/0029_onboarding_rota_env_only.sql',
    'migrations/0031_rota_primary_env_only.sql',
  ].map((path) => {
    const sql = readFileSync(path, 'utf8');
    const start = sql.indexOf('key NOT IN (');
    assert.ok(start >= 0, `${path}: the CHECK list is gone`);
    return sql.slice(start);
  }).join('\n');
  const inSql = [
    ...new Set(
      list
        .split('\n')
        .map((l) => l.replace(/--.*$/, '')) // drop SQL comments, keep the names
        .join('\n')
        .matchAll(/'([A-Z][A-Z0-9_]+)'/g),
    ),
  ]
    .map((m) => m[1])
    .sort();

  // The prefix carve-out below is only sound while the prefix set is exactly
  // the one 0026's CHECK encodes. A second prefix here and no matching
  // constraint there would silently shrink what the schema refuses.
  assert.deepEqual([...ENV_ONLY_KEY_PREFIXES], ['TWO_INTERNAL_']);
  assert.match(
    readFileSync('migrations/0026_guild_settings.sql', 'utf8'),
    /CHECK \(key NOT LIKE 'TWO\\_INTERNAL\\_%'\)/,
    "0026's prefix CHECK is the other half of this rule and must still be there",
  );

  const inCatalog = Object.entries(SETTING_CLASSES)
    .filter(([name, cls]) => cls === 'env_only' && !name.startsWith('TWO_INTERNAL_'))
    .map(([name]) => name)
    .sort();

  assert.ok(inSql.length > 0, 'parsed no names out of the 0027 CHECK - the parse is broken');
  assert.deepEqual(
    inSql,
    inCatalog,
    'The env-only CHECK constraints and SETTING_CLASSES disagree. ' +
      'Both must list every env_only name outside the TWO_INTERNAL_ prefix: ' +
      `only in SQL [${inSql.filter((n) => !inCatalog.includes(n))}], ` +
      `only in the catalog [${inCatalog.filter((n) => !inSql.includes(n))}]`,
  );
});

test('no key is both prefix-refused and classed storable', () => {
  for (const [name, cls] of Object.entries(SETTING_CLASSES)) {
    if (ENV_ONLY_KEY_PREFIXES.some((p) => name.startsWith(p))) {
      assert.equal(cls, 'env_only', `${name} carries an env-only prefix but is classed ${cls}`);
    }
  }
});

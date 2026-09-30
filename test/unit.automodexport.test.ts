/**
 * AutoMod rulesExport acceptance (TOG-9134).
 *
 * Scope: `src/automod/rulesExport.ts` (via `scripts/automod-export.ts`).
 *
 * Gap source: the only test reference was the acceptance file from TOG-5700,
 * which exercises `validateAutomodRules` with two inline rules but pins
 * nothing about the real Discord export shape - a keyword rule with
 * trigger_metadata, exempt roles/channels, or a disabled rule could regress
 * without a test noticing. This file pins that shape against a golden
 * fixture with no Postgres, no token, no network.
 *
 *   1. golden shape: the fixture on disk validates clean, and its ids, names,
 *      trigger types, actions, exempt lists and enabled flags are asserted
 *      field by field. Editing the fixture without updating these pins fails.
 *   2. passthrough: everything the export does not name (trigger_metadata,
 *      guild_id, action metadata) survives validation byte-identical, so the
 *      audit file is a faithful copy of what Discord returned.
 *   3. file round-trip: no importer exists - the only consumer,
 *      `scripts/automod-export.ts`, writes validated rules straight to disk
 *      and nothing reads them back. The import path this pins is the one the
 *      script itself would take on re-ingest: write the file exactly as the
 *      script does, read it back, re-validate, and require identical output.
 *
 * Fixture ids live in the 9000000000000000 block Discord never allocates, so
 * nothing here is a real guild, channel, role or rule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutomodExportError,
  validateAutomodRules,
} from '../src/automod/rulesExport.ts';

const FIXTURE_PATH = new URL('./fixtures/automod-rules-export.json', import.meta.url).pathname;

async function loadFixtureRules(): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  assert.ok(parsed && typeof parsed === 'object', 'fixture must be an object');
  const rules = (parsed as { rules?: unknown }).rules;
  assert.ok(Array.isArray(rules), 'fixture must carry a rules array');
  return rules;
}

describe('automod export golden shape (TOG-9134)', () => {
  test('the fixture validates clean and pins ids, names and trigger types', async () => {
    const rules = validateAutomodRules(await loadFixtureRules());
    assert.equal(rules.length, 3);
    assert.deepEqual(
      rules.map((r) => [r.id, r.name]),
      [
        ['900000000000000101', 'slur blocklist'],
        ['900000000000000102', 'spam throttle'],
        ['900000000000000103', 'mention spam guard'],
      ],
    );
    assert.deepEqual(
      rules.map((r) => r.trigger_type),
      [1, 3, 5],
      'keyword, spam and mention-spam triggers are all represented',
    );
  });

  test('actions, exempts and enabled flags survive as written', async () => {
    const rules = validateAutomodRules(await loadFixtureRules());
    const [keyword, spam, mentions] = rules;

    assert.deepEqual(
      (keyword.actions as Array<{ type: number }>).map((a) => a.type),
      [1, 2],
      'multi-action rule keeps both actions in order',
    );
    assert.deepEqual(keyword.exempt_roles, ['900000000000000111']);
    assert.deepEqual(keyword.exempt_channels, ['900000000000000012']);
    assert.equal(keyword.enabled, true);

    assert.deepEqual(spam.actions, [{ type: 3, metadata: { duration_seconds: 600 } }]);
    assert.equal(spam.enabled, true);

    assert.deepEqual(mentions.exempt_roles, ['900000000000000111', '900000000000000112']);
    assert.equal(mentions.enabled, false, 'a disabled rule still exports');
  });

  test('unnamed fields pass through byte-identical', async () => {
    const raw = (await loadFixtureRules()) as Array<Record<string, unknown>>;
    const rules = validateAutomodRules(structuredClone(raw));
    assert.equal(JSON.stringify(rules), JSON.stringify(raw));
    const keyword = rules[0];
    assert.deepEqual(keyword.trigger_metadata, {
      keyword_filter: ['very bad', 'worse phrase'],
      regex_patterns: ['b[a@]d\\d+'],
      allow_list: ['very bad movie night'],
    });
    assert.equal(keyword.guild_id, '900000000000000000');
  });
});

describe('automod export file round-trip (TOG-9134)', () => {
  test('write exactly as the script does, read back, re-validate identical', async () => {
    // No importer exists: scripts/automod-export.ts writes validated rules to
    // disk and nothing reads them back. This is the write half plus the
    // re-ingest gate the same validator would apply on read.
    const rules = validateAutomodRules(await loadFixtureRules());
    const dir = await mkdtemp(join(tmpdir(), 'two-automod-export-'));
    try {
      const out = join(dir, 'staging-automod-rules.json');
      await writeFile(out, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
      const reread: unknown = JSON.parse(await readFile(out, 'utf8'));
      const revalidated = validateAutomodRules(reread);
      assert.equal(JSON.stringify(revalidated), JSON.stringify(rules));
      assert.equal(JSON.stringify(revalidated), JSON.stringify(await loadFixtureRules()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a corrupted file fails re-validation instead of importing half a payload', async () => {
    const rules = validateAutomodRules(await loadFixtureRules());
    const dir = await mkdtemp(join(tmpdir(), 'two-automod-export-'));
    try {
      const out = join(dir, 'staging-automod-rules.json');
      const tampered = structuredClone(rules) as Array<Record<string, unknown>>;
      delete tampered[1].id;
      await writeFile(out, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
      const reread: unknown = JSON.parse(await readFile(out, 'utf8'));
      assert.throws(() => validateAutomodRules(reread), AutomodExportError);
      try {
        validateAutomodRules(reread);
      } catch (e) {
        assert.ok(e instanceof AutomodExportError);
        assert.match(e.problems.join('\n'), /row 2.*invalid Discord rule id/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Campaign-slug validation fuzz (TOG-9987, round-5 gap F17).
 *
 * Hermetic by construction: a counting in-memory Db, no Postgres, no token,
 * no listener, no network. The property being proved is fail-closed input
 * handling at the validator and the store door:
 *
 *   - every traversal / reserved / port / unicode / overlong / control slug is
 *     refused by `CampaignStore.add()` with a NAMED error (`Invalid campaign
 *     slug` or `reserved`), never reaching the database (`calls.run === 0`);
 *   - every such slug resolves to null in `lookup()` without touching the
 *     database (`calls.get === 0`), which is what keeps a bot walking URLs
 *     from turning 404s into load;
 *   - the exact `healthz` slug passes the shape check (the trap) but is
 *     refused as reserved at add time, because `GET /healthz` is answered
 *     before campaign lookup and would silently die;
 *   - valid slugs still pass, so the fuzz did not over-block.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.redirect-slugfuzz-offline.test.ts
 *
 * HTTP decode behaviour (e.g. `/%72eddit` -> `reddit`) lives in
 * test/unit.redirect.test.ts; what is pinned here is the validator the HTTP
 * layer funnels into. A raw `%` never appears in a valid slug: decoding
 * happens before lookup, and the decoded value must still pass `isValidSlug`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignStore, isReservedSlug, isValidSlug } from '../src/redirect/campaigns.ts';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';

const NOW = '2026-09-03T12:00:00.000Z';
const CODE = 'aB3xY9';

/** In-memory invite_campaigns with counters, so "never reaches the DB" is observable. */
function fakeDb(): { db: Db; calls: { get: number; all: number; run: number } } {
  const rows = new Map<string, Record<string, unknown>>();
  const calls = { get: 0, all: 0, run: 0 };
  const statement = (sql: string): Statement => ({
    async get<T>(...params: unknown[]): Promise<T | undefined> {
      calls.get++;
      if (sql.includes('WHERE slug = ?')) {
        const row = rows.get(String(params[0]));
        return (row ? { ...row } : undefined) as T | undefined;
      }
      return undefined;
    },
    async all<T>(): Promise<T[]> {
      calls.all++;
      // Mimic ORDER BY slug in the real query.
      return [...rows.values()]
        .sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
        .map((r) => ({ ...r })) as T[];
    },
    async run(...params: unknown[]): Promise<RunResult> {
      calls.run++;
      if (sql.startsWith('INSERT INTO invite_campaigns')) {
        const [slug, inviteCode, label, createdAt] = params as [string, string, string, string];
        if (rows.has(slug)) return { changes: 0 };
        rows.set(slug, { slug, invite_code: inviteCode, label, disabled_at: null, created_at: createdAt });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  });
  const db: Db = {
    prepare: (sql: string) => statement(sql),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    close: async () => {},
  };
  return { db, calls };
}

// --- the corpus ---------------------------------------------------------------

/** Dot, slash, backslash and encoded-separator shapes: directory traversal at the slug layer. */
const TRAVERSAL = [
  '..',
  '.',
  '/',
  '\\',
  '../',
  '..\\',
  '../../etc/passwd',
  'etc/passwd',
  'etc\\passwd',
  'a/b',
  'a\\b',
  'a.b',
  '.lead',
  'trail.',
  'a..b',
  '...',
  '---',
  '%2e',
  '%2E',
  '%2f',
  '%2F',
  '%5c',
  '..%2f',
  '..%2F',
  '%2e%2e',
  '%252f',
  '%00',
  'a%00b',
  'reddit%2f..',
  'reddit%00',
  '//evil',
  '///evil',
  '\\\\evil',
];

/** The reserved probe answer plus case, padding and lookalike variants. */
const RESERVED = [
  'healthz',
  'HEALTHZ',
  'Healthz',
  'hEaLtHz',
  ' healthz',
  'healthz ',
  'healthz\n',
  'healthz\t',
  'favicon.ico',
  'robots.txt',
];

/** Colons, dots-and-hosts and scheme shapes: nothing after the slug may name a port or host. */
const PORTS_AND_HOSTS = [
  'localhost:8088',
  '127.0.0.1:8088',
  'example.com:8088',
  'reddit:80',
  ':8088',
  'a:80',
  'a:b',
  '::1',
  'go.two.gg/reddit',
  'discord.gg/abc',
  'https://evil.example',
  'http://evil.example/reddit',
  '//evil.example',
  'HTTPS://EVIL',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
];

/**
 * Non-ASCII, homoglyph and invisible-character shapes: the allowlist is ASCII
 * for a reason. Invisible entries below are deliberate: `r<U+200B>eddit`
 * (zero-width space), `reddit<U+0301>` (combining acute), `a<U+00A0>b`
 * (non-breaking space), `<U+00AD>reddit` (soft hyphen). Keep them as literal
 * characters — `\u` escapes would still pass through the same validator, but
 * literals prove what a pasted slug actually looks like in an editor.
 */
const UNICODE = [
  'café',
  'naïve',
  'straße',
  '中文',
  '中文slug',
  '🎉party',
  'party🎉',
  'r​eddit',
  'reddít',
  'ﬁsh',
  'ｒeddit',
  'Reddit',
  'UPPER',
  'a b',
  '­reddit',
];

/** Length edges: empty, single, hyphen-only and hyphen-edged, plus overflow past the 40-char cap. */
const OVERLONG_AND_EDGES = [
  '',
  'a',
  '-',
  '--',
  '-a',
  'a-',
  '-lead',
  'trail-',
  'a'.repeat(41),
  'a'.repeat(100),
  'a'.repeat(1000),
  '-'.repeat(40),
  `${'a-'}${'b'.repeat(39)}`,
];

/** Whitespace and control characters: headers and logs must never see these from a slug. */
const CONTROL = [
  'has space',
  ' a',
  'a ',
  'a\nb',
  'a\rb',
  'a\tb',
  'a\0b',
  '\n',
  '\t',
  'tab\there',
];

/** Shapes that must KEEP working: the fuzz proves refusal, not over-blocking. */
const VALID = [
  'reddit',
  'ab',
  'a0',
  '0a',
  'r-mmorpg',
  'twitch-panel-2',
  '8088',
  'healthz-panel',
  'a'.repeat(40),
];

/** Every shape the suite demands a named refusal for. `healthz` is the one valid-shape trap. */
const MALICIOUS = [...TRAVERSAL, ...RESERVED, ...PORTS_AND_HOSTS, ...UNICODE, ...OVERLONG_AND_EDGES, ...CONTROL];

// --- helpers --------------------------------------------------------------------

/** The named refusal add() must answer with for a slug that is not exactly `healthz`. */
const NAMED_REFUSAL = /Invalid campaign slug|reserved/;

async function assertAddRefused(
  store: CampaignStore,
  slug: string,
  pattern: RegExp = NAMED_REFUSAL,
): Promise<string> {
  await assert.rejects(
    store.add({ slug, inviteCode: CODE, label: 'fuzz', createdAt: NOW }),
    (error: unknown) => {
      assert.match(String((error as Error)?.message ?? error), pattern, `slug ${JSON.stringify(slug)}`);
      return true;
    },
    `slug ${JSON.stringify(slug)} must be refused with a named error`,
  );
  return slug;
}

// --- the fuzz ---------------------------------------------------------------------

test('traversal shapes are refused with a named slug error and never reach the database', async () => {
  assert.ok(TRAVERSAL.length >= 20, 'corpus must not silently shrink');
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  for (const slug of TRAVERSAL) {
    assert.ok(!isValidSlug(slug), `traversal slug ${JSON.stringify(slug)} must fail the shape check`);
    assert.equal(await store.lookup(slug), null, `${JSON.stringify(slug)} must resolve to null`);
    await assertAddRefused(store, slug);
  }
  assert.equal(calls.get, 0, 'invalid slugs must never reach the database on lookup');
  assert.equal(calls.run, 0, 'refused slugs must never reach the database on add');
});

test('reserved names are refused — exact healthz as reserved, variants as invalid', async () => {
  // The trap: `healthz` passes the shape check, so the reserved refusal is the
  // only thing stopping a campaign that could never redirect (GET /healthz is
  // answered before lookup). Case and padding variants never get that far:
  // the shape check refuses them first, which is still a named refusal.
  assert.ok(isValidSlug('healthz'), 'healthz passes the shape check - that is the trap');
  assert.ok(isReservedSlug('healthz'));
  assert.ok(isReservedSlug('HEALTHZ'), 'the reserved check is case-insensitive');
  assert.ok(!isReservedSlug('reddit'));

  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  await assert.rejects(
    store.add({ slug: 'healthz', inviteCode: CODE, label: 'fuzz', createdAt: NOW }),
    /reserved/,
    'exact healthz must be refused as reserved, not merely invalid',
  );
  for (const slug of RESERVED.filter((s) => s !== 'healthz')) {
    assert.ok(!isValidSlug(slug), `reserved variant ${JSON.stringify(slug)} must fail the shape check`);
    await assertAddRefused(store, slug);
  }
  assert.equal(calls.run, 0, 'a reserved slug must never reach the database');
});

test('port, host and scheme shapes are refused with a named slug error', async () => {
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  for (const slug of PORTS_AND_HOSTS) {
    assert.ok(!isValidSlug(slug), `port/host slug ${JSON.stringify(slug)} must fail the shape check`);
    assert.equal(await store.lookup(slug), null, `${JSON.stringify(slug)} must resolve to null`);
    await assertAddRefused(store, slug);
  }
  assert.equal(calls.get, 0, 'port/host slugs must never reach the database on lookup');
  assert.equal(calls.run, 0, 'port/host slugs must never reach the database on add');
});

test('unicode and homoglyph shapes are refused with a named slug error', async () => {
  // Slugs are read aloud and retyped; anything outside [a-z0-9-] is refused
  // rather than normalized, so NFKC games, bidi overrides and zero-width
  // characters have no foothold.
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  for (const slug of UNICODE) {
    assert.ok(!isValidSlug(slug), `unicode slug ${JSON.stringify(slug)} must fail the shape check`);
    assert.equal(await store.lookup(slug), null, `${JSON.stringify(slug)} must resolve to null`);
    await assertAddRefused(store, slug);
  }
  assert.equal(calls.get, 0, 'unicode slugs must never reach the database on lookup');
  assert.equal(calls.run, 0, 'unicode slugs must never reach the database on add');
});

test('overlong and edge-length shapes: boundaries pinned, overflow refused', async () => {
  assert.ok(isValidSlug('ab'), '2 chars is the minimum');
  assert.ok(isValidSlug('a'.repeat(40)), '40 chars is the maximum');
  assert.ok(!isValidSlug('a'.repeat(41)), '41 chars overflows');
  assert.ok(!isValidSlug(''), 'empty is refused');
  assert.ok(!isValidSlug('a'), 'a single char is refused');

  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  for (const slug of OVERLONG_AND_EDGES) {
    assert.ok(!isValidSlug(slug), `edge slug ${JSON.stringify(slug.slice(0, 44))} must fail the shape check`);
    assert.equal(await store.lookup(slug), null, 'overlong slug must resolve to null');
    await assertAddRefused(store, slug);
  }
  assert.equal(calls.get, 0, 'overlong slugs must never reach the database on lookup');
  assert.equal(calls.run, 0, 'overlong slugs must never reach the database on add');
});

test('control characters and whitespace are refused with a named slug error', async () => {
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  for (const slug of CONTROL) {
    assert.ok(!isValidSlug(slug), `control slug ${JSON.stringify(slug)} must fail the shape check`);
    assert.equal(await store.lookup(slug), null, `${JSON.stringify(slug)} must resolve to null`);
    await assertAddRefused(store, slug);
  }
  assert.equal(calls.get, 0, 'control slugs must never reach the database on lookup');
  assert.equal(calls.run, 0, 'control slugs must never reach the database on add');
});

test('valid slugs still pass — the fuzz did not over-block', async () => {
  // Pure-digit slugs (e.g. a port number alone) pass the shape check: with no
  // colon, dot or host semantics they are just names, resolved by lookup like
  // any other slug. `healthz-panel` is not the reserved probe path.
  const { db } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  for (const slug of VALID) {
    assert.ok(isValidSlug(slug), `valid slug ${JSON.stringify(slug)} must pass the shape check`);
    await store.add({ slug, inviteCode: CODE, label: 'fuzz-control', createdAt: NOW });
    assert.equal((await store.lookup(slug))?.slug, slug, `${JSON.stringify(slug)} must round-trip`);
  }
  assert.deepEqual(
    (await store.list()).map((c) => c.slug),
    [...VALID].sort(),
    'every valid slug was stored',
  );
});

test('sweep: every malicious slug in the corpus is refused with a named error', async () => {
  assert.ok(MALICIOUS.length >= 70, `corpus must not silently shrink (saw ${MALICIOUS.length})`);
  const { db, calls } = fakeDb();
  const store = new CampaignStore(db, { ttlMs: 0 });
  const named: Record<string, number> = { 'invalid-slug': 0, reserved: 0 };
  for (const slug of MALICIOUS) {
    const refusedAsReserved = isReservedSlug(slug) && isValidSlug(slug);
    await assert.rejects(
      store.add({ slug, inviteCode: CODE, label: 'fuzz-sweep', createdAt: NOW }),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        const name = /reserved/.test(message) ? 'reserved' : /Invalid campaign slug/.test(message) ? 'invalid-slug' : null;
        assert.ok(name !== null, `slug ${JSON.stringify(slug)} refused without a named error: ${message}`);
        named[name] += 1;
        if (refusedAsReserved) assert.equal(name, 'reserved', `${JSON.stringify(slug)} must be refused as reserved`);
        return true;
      },
      `slug ${JSON.stringify(slug)} must be refused with a named error`,
    );
    assert.equal(await store.lookup(slug), null, `${JSON.stringify(slug)} must resolve to null`);
  }
  assert.equal(
    named['invalid-slug']! + named['reserved']!,
    MALICIOUS.length,
    'every malicious slug got exactly one named refusal',
  );
  assert.ok(named['reserved']! >= 1, 'the sweep must exercise the reserved refusal');
  assert.equal(calls.run, 0, 'no malicious slug reached the database on add');
  // `healthz` passes the shape check (the trap), so its lookup legitimately
  // queries once and misses; every other malicious slug fails the shape check
  // and must never reach the database.
  const validShape = MALICIOUS.filter((s) => isValidSlug(s));
  assert.deepEqual(validShape, ['healthz'], 'healthz is the only valid-shape slug in the corpus');
  assert.equal(calls.get, 1, 'only the valid-shape trap slug may query on lookup');
});

/**
 * Roster + welcome-list output tests (TOG-5721).
 *
 * Scope: `scripts/roster.ts`, `src/discord/sessionWelcome.ts`,
 * `src/discord/anchorWelcome.ts`.
 *
 * What this pins, fixture-driven, with no Postgres, no token, no network:
 *
 *   1. never-posted list: a voice-only member is OUT of `joinedNeverPosted`
 *      (both firsts are read) but still reads `NO` under `posted?` in the
 *      roster text (that column is messages-only). The two "never posted"
 *      meanings differ on purpose; this is the test that says so.
 *   2. inactivity flags: `flagInactive` flags the quiet and the never-active,
 *      spares the fresh/active/left/bot, flags nothing on a repeat sweep, and
 *      writes only `member_inactive`.
 *   3. welcome content rendering: the session welcome, goodbye, and anchor
 *      welcome post byte-identical text to the pure copy functions - the
 *      adapters render, they do not write copy.
 *   4. content-team editable: the three scope files hold no welcome/roster
 *      copy literals of their own (comments stripped before checking, so the
 *      statement of the rule cannot satisfy it). Copy changes land in
 *      `cliFormat.ts` / `session.ts` / `anchorEvent.ts`; a hardcoded surprise
 *      in a scope file fails here first.
 *
 * The one sanctioned duplication is the select-menu placeholder
 * (`What do you want to do right now?`), which lives in the discord.js builder
 * call in `sessionWelcome.ts` and is already pinned to the intro lead by
 * `unit.onboardingpickercopy.test.ts` (TOG-4962). It is allow-listed below.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from '../src/store/eventStore.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import type { Db, Statement } from '../src/store/db.ts';
import {
  describeRosterSource,
  formatRosterText,
  type RosterTextRow,
} from '../src/analytics/cliFormat.ts';
import {
  SESSION_PICKS,
  SESSION_SELECT_ID,
  daysInGuild,
  goodbyeText,
  sessionWelcomeText,
} from '../src/onboarding/session.ts';
import {
  SUNDAY_SQUAD,
  anchorWelcomeText,
} from '../src/onboarding/anchorEvent.ts';
import { registerSessionWelcome } from '../src/discord/sessionWelcome.ts';
import { sendAnchorWelcome } from '../src/discord/anchorWelcome.ts';

const GUILD = 'g5721';
const LANDING = '111111111111111111';
const GOODBYE = '222222222222222222';
const ANCHOR = '333333333333333333';
const DAY = 86_400_000;

// --- scope sources, comments stripped ----------------------------------------
// Block comments name the guarantee ("no hardcoded copy"); line comments quote
// example output. Strip both so the prose cannot satisfy the check.

function scopeCode(path: string): string {
  const src = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const ROSTER_CODE = scopeCode('scripts/roster.ts');
const SESSION_ADAPTER_CODE = scopeCode('src/discord/sessionWelcome.ts');
const ANCHOR_ADAPTER_CODE = scopeCode('src/discord/anchorWelcome.ts');

/** Every welcome/roster copy string the pure modules own. None may appear in a scope file. */
const OWNED_COPY = [
  "you're in",
  'whole application',
  'not a label forever',
  'On it - head',
  'left the server',
  "glad you're here",
  'Sunday Squad',
  'Fall Guys',
  'happening right now',
  'posted?',
  'still here?',
  'never posted',
  're-engagement',
  'No joins recorded',
  'came from',
  'attributed to a specific invite',
];

describe('content-team editable: scope files carry no copy of their own', () => {
  test('no owned copy literal in any scope file', () => {
    for (const [name, code] of [
      ['scripts/roster.ts', ROSTER_CODE],
      ['src/discord/sessionWelcome.ts', SESSION_ADAPTER_CODE],
      ['src/discord/anchorWelcome.ts', ANCHOR_ADAPTER_CODE],
    ] as const) {
      for (const lit of OWNED_COPY) {
        assert.ok(
          !code.includes(lit),
          `${name} hardcodes copy that the content team owns elsewhere: ${JSON.stringify(lit)}`,
        );
      }
    }
  });

  test('each scope file delegates to its pure renderer by name', () => {
    assert.ok(ROSTER_CODE.includes('formatRosterText'), 'roster.ts must render via formatRosterText');
    for (const fn of ['sessionWelcomeText', 'goodbyeText', 'sessionAckText', 'planSession']) {
      assert.ok(SESSION_ADAPTER_CODE.includes(fn), `sessionWelcome.ts must delegate to ${fn}`);
    }
    assert.ok(ANCHOR_ADAPTER_CODE.includes('anchorWelcomeText'), 'anchorWelcome.ts must delegate to anchorWelcomeText');
  });

  test('the select placeholder is the one sanctioned duplication (TOG-4962)', () => {
    // The discord.js builder needs the literal; the picker-copy test pins it to
    // the intro lead, so a content edit updates both or fails there.
    assert.ok(
      SESSION_ADAPTER_CODE.includes(".setPlaceholder('What do you want to do right now?')"),
      'session placeholder moved; see unit.onboardingpickercopy.test.ts',
    );
    assert.ok(
      sessionWelcomeText('@member').includes('What do you want to do right now?'),
      'intro lead moved away from the placeholder; update both together',
    );
  });

  test('source labels render through describeRosterSource, never raw', () => {
    assert.equal(describeRosterSource('invite:abc123'), 'abc123');
    assert.equal(describeRosterSource('backfill:log:member-join'), 'unknown (pre-tracking)');
    assert.equal(describeRosterSource(null), 'unknown');
  });
});

// --- offline Db over node:sqlite ---------------------------------------------

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  const stmt = db.prepare(sql);
  return {
    get: async <T>(...params: unknown[]): Promise<T | undefined> =>
      stmt.get(...(params as never[])) as T | undefined,
    all: async <T>(...params: unknown[]): Promise<T[]> =>
      stmt.all(...(params as never[])) as T[],
    run: async (...params: unknown[]): Promise<{ changes: number }> => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, member_id TEXT, guild_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, metadata TEXT, idempotency_key TEXT NOT NULL UNIQUE
  )`);
  db.exec(`CREATE TABLE members (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    joined_at TEXT, join_source TEXT, first_message_at TEXT,
    first_voice_at TEXT, last_active_at TEXT, left_at TEXT,
    inactive_flagged_at TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id)
  )`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

interface SeedOpts {
  joinedAt: string;
  firstMessageAt?: string | null;
  firstVoiceAt?: string | null;
  lastActiveAt?: string | null;
  isBot?: boolean;
  leftAt?: string | null;
}

async function seedMember(db: Db, id: string, o: SeedOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, first_voice_at,
                            last_active_at, is_bot, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      GUILD, id, o.joinedAt, o.firstMessageAt ?? null, o.firstVoiceAt ?? null,
      o.lastActiveAt ?? null, o.isBot ? 1 : 0, o.leftAt ?? null,
    );
}

async function eventTypes(db: Db): Promise<string[]> {
  return (await db.prepare(`SELECT DISTINCT event_type AS t FROM events`).all<{ t: string }>())
    .map((r) => r.t)
    .sort();
}

// --- 1 + 2. never-posted list and inactivity flags ----------------------------

describe('never-posted list and inactivity flags', () => {
  test('joinedNeverPosted reads both firsts; the roster posted? column reads one', async () => {
    const db = openOfflineDb();
    const store = new EventStore(db);
    try {
      const J = '2026-09-20T00:00:00.000Z';
      await seedMember(db, 'silent', { joinedAt: J });
      await seedMember(db, 'voiceonly', { joinedAt: J, firstVoiceAt: '2026-09-21T00:00:00.000Z' });
      await seedMember(db, 'chatty', { joinedAt: J, firstMessageAt: '2026-09-21T00:00:00.000Z' });
      await seedMember(db, 'left', { joinedAt: J, leftAt: '2026-09-22T00:00:00.000Z' });
      await seedMember(db, 'bot', { joinedAt: J, isBot: true });
      void store;

      // Only the truly silent member is "joined and never said a word".
      assert.deepEqual(await joinedNeverPosted(db, GUILD), ['silent']);

      // The roster text counts messages only: voice-only still reads NO under
      // posted? while showing its voice visit. Same fixture, both meanings.
      const rows: RosterTextRow[] = [
        { memberId: 'silent', joinedAt: `${J}`, joinSource: 'invite:abc123', firstMessageAt: null, firstVoiceAt: null, leftAt: null },
        { memberId: 'voiceonly', joinedAt: J, joinSource: 'invite:abc123', firstMessageAt: null, firstVoiceAt: '2026-09-21T00:00:00.000Z', leftAt: null },
        { memberId: 'chatty', joinedAt: J, joinSource: 'vanity', firstMessageAt: '2026-09-21T00:00:00.000Z', firstVoiceAt: null, leftAt: null },
        { memberId: 'left', joinedAt: J, joinSource: 'backfill:log:member-join', firstMessageAt: null, firstVoiceAt: null, leftAt: '2026-09-22T00:00:00.000Z' },
      ];
      const text = formatRosterText(rows, 7, '2026-09-20T00:00:00.000Z');
      assert.ok(text.includes('4 members joined, 1 posted, 3 never posted'));
      // The re-engagement list is still-here AND never-posted: the leaver is out.
      assert.ok(text.includes('2 members still in the server and have never posted - the re-engagement list.'));
      const line = (id: string) => text.split('\n').find((l) => l.includes(id))!;
      assert.match(line('silent'), /NO\s+no\s+yes/);
      assert.match(line('voiceonly'), /NO\s+yes\s+yes/);
      assert.match(line('chatty'), /yes\s+no\s+yes/);
      assert.match(line('left'), /left\s*$/);
      assert.ok(!text.includes('invite:abc123'), 'raw invite: prefix must not leak');
      assert.ok(!text.includes('backfill:'), 'raw backfill: prefix must not leak');
    } finally {
      await db.close();
    }
  });

  test('flagInactive flags the quiet and the never-active, spares the rest, writes one event type', async () => {
    const db = openOfflineDb();
    const store = new EventStore(db);
    try {
      const ago = (n: number) => new Date(Date.now() - n * DAY).toISOString();
      await seedMember(db, 'quiet-90', { joinedAt: ago(90), lastActiveAt: ago(60) });
      await seedMember(db, 'idle-never', { joinedAt: ago(90) });
      await seedMember(db, 'fresh', { joinedAt: ago(90), lastActiveAt: ago(1) });
      await seedMember(db, 'left-quiet', { joinedAt: ago(90), lastActiveAt: ago(60), leftAt: ago(30) });
      await seedMember(db, 'bot-quiet', { joinedAt: ago(90), lastActiveAt: ago(60), isBot: true });

      assert.deepEqual((await flagInactive(db, store, 14)).sort(), ['idle-never', 'quiet-90']);
      // A repeat sweep flags nothing new: no repeat nudge.
      assert.deepEqual(await flagInactive(db, store, 14), []);
      assert.deepEqual(await eventTypes(db), ['member_inactive']);
    } finally {
      await db.close();
    }
  });

  test('empty window: empty list, empty roster guidance, no events', async () => {
    const db = openOfflineDb();
    const store = new EventStore(db);
    try {
      assert.deepEqual(await flagInactive(db, store, 14), []);
      assert.deepEqual(await joinedNeverPosted(db, GUILD), []);
      const text = formatRosterText([], 7, '2026-09-20T00:00:00.000Z');
      assert.ok(text.includes('No joins recorded in this window.'));
      assert.ok(!text.includes('posted?'), 'no table header on the empty path');
      assert.deepEqual(await eventTypes(db), [], 'an empty run writes no events at all');
    } finally {
      await db.close();
    }
  });
});

// --- 3. welcome content rendering through the adapters ------------------------

function makeClient() {
  const emitter = new EventEmitter() as any;
  emitter.channels = { cache: new Map<string, any>() };
  emitter.user = { id: '999999999999999999' };
  return emitter;
}

function addPostableChannel(client: any, channelId: string, sends: { channelId: string; payload: any }[]) {
  const channel: any = {
    id: channelId,
    guild: { id: GUILD, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: any) => {
      sends.push({ channelId, payload });
      return { id: `msg-${channelId.slice(-4)}`, guildId: GUILD, channelId };
    },
  };
  client.channels.cache.set(channelId, channel);
  return channel;
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('welcome content renders the pure copy, nothing else', () => {
  test('session welcome posts sessionWelcomeText plus the picker, mentioning only the member', async () => {
    const client = makeClient();
    const sends: { channelId: string; payload: any }[] = [];
    addPostableChannel(client, LANDING, sends);
    const prompted: any[] = [];
    const member: any = {
      id: 'u-welcome-1',
      guild: { id: GUILD, channels: { cache: new Map() } },
      user: { bot: false, username: 'ava' },
      pending: false,
      joinedAt: new Date(Date.now() - 3 * DAY),
      displayName: 'Ava',
    };

    registerSessionWelcome(client, {
      recorder: { async prompted(g: string, m: string, c: string) { prompted.push([g, m, c]); }, async routed() {} } as any,
      store: { async hasEvent() { return false; } } as any,
      guildId: GUILD,
      landingChannelIds: () => [LANDING],
      goodbyeChannelIds: () => [GOODBYE],
      picks: SESSION_PICKS,
    });

    client.emit(Events.GuildMemberAdd, member);
    await waitFor(() => sends.length === 1, 'session welcome send');

    assert.equal(sends[0].channelId, LANDING);
    assert.equal(sends[0].payload.content, sessionWelcomeText(`<@${member.id}>`));
    assert.equal(sends[0].payload.components?.length, 1, 'the picker rides with the welcome');
    assert.ok(
      JSON.stringify(sends[0].payload.components).includes(SESSION_SELECT_ID),
      'the picker component carries the stable select id',
    );
    assert.deepEqual(sends[0].payload.allowedMentions, { users: [member.id] });
    assert.deepEqual(prompted, [[GUILD, member.id, LANDING]]);
  });

  test('session goodbye posts goodbyeText computed from the same pure functions, pinging nobody', async () => {
    const client = makeClient();
    const sends: { channelId: string; payload: any }[] = [];
    addPostableChannel(client, GOODBYE, sends);
    const joinedAt = new Date(Date.now() - 3 * DAY - 3_600_000);
    const member: any = {
      id: 'u-goodbye-1',
      guild: { id: GUILD, channels: { cache: new Map() } },
      user: { bot: false, username: 'bo' },
      pending: false,
      joinedAt,
      displayName: 'Bo',
    };

    registerSessionWelcome(client, {
      recorder: { async prompted() {}, async routed() {} } as any,
      store: { async hasEvent() { return false; } } as any,
      guildId: GUILD,
      landingChannelIds: () => [LANDING],
      goodbyeChannelIds: () => [GOODBYE],
      picks: SESSION_PICKS,
    });

    client.emit(Events.GuildMemberRemove, member);
    await waitFor(() => sends.length === 1, 'session goodbye send');

    const expected = goodbyeText('bo', daysInGuild(joinedAt.toISOString(), new Date().toISOString()));
    assert.equal(sends[0].payload.content, expected);
    assert.deepEqual(sends[0].payload.allowedMentions, { parse: [] }, 'never ping the person who left');
  });

  test('anchor welcome posts anchorWelcomeText with nothing appended, pinging only the member', async () => {
    const client = makeClient();
    const sends: { channelId: string; payload: any }[] = [];
    addPostableChannel(client, ANCHOR, sends);
    const prompted: any[] = [];
    const routed: any[] = [];
    const member: any = { id: 'u-anchor-1', guild: { id: GUILD }, user: { bot: false }, pending: false };
    // A quiet Wednesday: the normal voice with a live relative timestamp.
    const at = Date.parse('2026-08-26T15:00:00Z');

    const ok = await sendAnchorWelcome(client, member, {
      recorder: {
        async shouldPrompt() { return { shouldPrompt: true, reason: 'ok' }; },
        async prompted(g: string, m: string, c: string) { prompted.push([g, m, c]); },
        async routed(g: string, m: string, p: any) { routed.push([g, m, p]); },
      } as any,
      channelId: ANCHOR,
      spec: { ...SUNDAY_SQUAD, channelId: ANCHOR },
      now: () => at,
    });

    assert.equal(ok, true);
    assert.equal(sends.length, 1, 'exactly one anchor message');
    assert.equal(
      sends[0].payload.content,
      anchorWelcomeText(`<@${member.id}>`, at, { ...SUNDAY_SQUAD, channelId: ANCHOR }),
    );
    assert.ok(!sends[0].payload.components || sends[0].payload.components.length === 0, 'TOG-93: nothing appended');
    assert.ok(!sends[0].payload.embeds || sends[0].payload.embeds.length === 0, 'TOG-93: nothing appended');
    assert.deepEqual(sends[0].payload.allowedMentions, { users: [member.id], roles: [], parse: [] });
    assert.equal(prompted.length, 1, 'prompted recorded after the send');
    assert.equal(routed.length, 1, 'routed recorded after the send');
  });
});

/**
 * The presence probe's query cost, measured on a seeded large guild (TOG-7206).
 *
 * The bot-floor scan pages the whole roster as full member JSON once a day.
 * Nothing else in the probe touches per-member data, so this file measures
 * exactly two costs and pins the ceilings that bound them:
 *
 *   1. Discord REST cost: member-list requests per floor scan, as a function
 *      of guild size. Seeded stub guilds at 107 members (today's size), 10k
 *      (the cap boundary) and 25k (past it).
 *   2. Database cost: rows the trend report's query actually reads with and
 *      without the --days window, against a seeded two-year hourly series.
 *
 * The numbers this file prints are the evidence for BOT_FLOOR_MAX_PAGES and
 * the readSeries `since` bound. If a measurement here changes, the ceiling it
 * justifies changes with it - update the constant and the PR body together.
 *
 * This file seeds and reads `presence_probe` but never renders it: same
 * non-rendering status as unit.presenceprobe.test.ts, which allowlists it.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/store/db.ts';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import { DiscordRest, type RawMember } from '../src/discord/rest.ts';
import {
  runProbeCycle,
  readSeries,
  recordReading,
  countBotFloor,
  BOT_FLOOR_MAX_PAGES,
  BOT_FLOOR_MAX_AGE_MS,
  PRESENCE_PROBE_INTERVAL_MS,
  lastBotFloorAt,
} from '../src/jobs/presenceProbe.ts';

const GUILD = '326474832151838730';

/** N synthetic members with every 5th a bot, paged like Discord pages them. */
function guildPages(total: number, botsEvery = 5): RawMember[][] {
  const members: RawMember[] = Array.from({ length: total }, (_, i) => ({
    user: { id: String(100_000 + i), bot: i % botsEvery === 0 },
  }));
  const pages: RawMember[][] = [];
  for (let i = 0; i < members.length; i += 1000) pages.push(members.slice(i, i + 1000));
  return pages;
}

/**
 * A DiscordRest serving fixed member pages, recording every request path.
 * Full 1000-member pages advance the cursor; a short page ends the scan, the
 * way Discord's `after` pagination does.
 */
function pagedRest(pages: RawMember[][], presence = 41, guildId = GUILD) {
  const paths: string[] = [];
  const rest = new DiscordRest({
    token: 'test-token',
    base: 'https://discord.test/api/v10',
    minIntervalMs: 0,
    fetchImpl: (async (url: string) => {
      const path = String(url).replace('https://discord.test/api/v10', '');
      paths.push(path);
      if (path.startsWith(`/guilds/${guildId}/members`)) {
        const after = new URL(url).searchParams.get('after') ?? '0';
        const pageIndex = after === '0' ? 0 : pages.findIndex((p) => p[p.length - 1]?.user?.id === after) + 1;
        const page = pages[Math.max(0, pageIndex)] ?? [];
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ approximate_presence_count: presence, approximate_member_count: 107 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch,
  });
  const memberRequests = () => paths.filter((p) => p.includes('/members')).length;
  return { rest, paths, memberRequests };
}

let harness: TestDb;
before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
});

describe('presence probe cost (TOG-7206)', () => {
  let db: Db;
  before(() => {
    db = harness.db;
  });

  test('a 107-member guild costs 1 presence read + 1 member page', async () => {
    const { rest, memberRequests } = pagedRest(guildPages(107));
    const res = await runProbeCycle({
      db,
      rest,
      guildId: GUILD,
      now: () => '2026-08-25T10:00:00.000Z',
      botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    assert.equal(res.recorded, true);
    assert.equal(res.botFloor, 22); // every 5th of 107, starting at index 0
    assert.equal(memberRequests(), 1);
    assert.equal(rest.requests, 2);
    console.log(
      `cost/107-member-guild: discord_requests=${rest.requests} member_pages=${memberRequests()} floor=${res.botFloor}`,
    );
  });

  test('a 10,000-member guild completes inside the ceiling', async () => {
    const { rest, memberRequests } = pagedRest(guildPages(10_000));
    const res = await runProbeCycle({
      db,
      rest,
      guildId: GUILD,
      now: () => '2026-08-25T10:00:00.000Z',
      botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    // 10 full pages then the empty terminator that proves completion: the
    // largest guild the ceiling promises to cover, covered.
    assert.equal(res.recorded, true);
    assert.equal(res.botFloor, 2000);
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES);
    console.log(
      `cost/10000-member-guild: discord_requests=${rest.requests} member_pages=${memberRequests()} floor=${res.botFloor}`,
    );
  });

  test('a 25,000-member guild truncates at the ceiling and keeps the presence reading', async () => {
    const { rest, memberRequests } = pagedRest(guildPages(25_000));
    const res = await runProbeCycle({
      db,
      rest,
      guildId: GUILD,
      now: () => '2026-08-25T10:00:00.000Z',
      botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    // The ceiling stops the scan: bounded requests, NO floor, presence kept.
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES);
    assert.equal(res.recorded, true);
    assert.equal(res.presence, 41);
    assert.equal(res.botFloor, null);
    assert.deepEqual(await readSeries(db, GUILD), [
      { observedAt: '2026-08-25T10:00:00.000Z', presence: 41, botFloor: null },
    ]);
    console.log(
      `cost/25000-member-guild: discord_requests=${rest.requests} member_pages=${memberRequests()} truncated=true presence_kept=true`,
    );
  });

  test('49 hourly oversized-guild cycles cost only three capped scans and keep every reading', async () => {
    const { rest, memberRequests } = pagedRest(guildPages(25_000));
    const start = Date.parse('2026-08-25T10:00:00.000Z');
    const expected = [];
    for (let hour = 0; hour <= 48; hour++) {
      const observedAt = new Date(start + hour * PRESENCE_PROBE_INTERVAL_MS).toISOString();
      const res = await runProbeCycle({
        db, rest, guildId: GUILD, now: () => observedAt, botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
      });
      assert.deepEqual(res, { recorded: true, presence: 41, botFloor: null, observedAt });
      assert.equal(memberRequests(), (Math.floor(hour / 24) + 1) * BOT_FLOOR_MAX_PAGES);
      expected.push({ observedAt, presence: 41, botFloor: null });
    }
    assert.deepEqual(await readSeries(db, GUILD), expected);
    assert.equal(await lastBotFloorAt(db, GUILD), null, 'truncation is never a successful floor');
    assert.equal(rest.requests, 49 + 3 * BOT_FLOOR_MAX_PAGES);
  });

  test('truncated retry cadence survives a fresh database connection and expires at the boundary', async () => {
    const { rest, memberRequests } = pagedRest(guildPages(25_000));
    const start = Date.parse('2026-08-25T10:00:00.000Z');
    const cycle = (client: Db, elapsed: number) => runProbeCycle({
      db: client, rest, guildId: GUILD,
      now: () => new Date(start + elapsed).toISOString(), botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    await cycle(db, 0);
    const reopened = await openDb(TEST_PG_URL, { schema: harness.schema });
    try {
      await cycle(reopened, PRESENCE_PROBE_INTERVAL_MS);
      await cycle(reopened, BOT_FLOOR_MAX_AGE_MS - 1);
      assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES);
      await cycle(reopened, BOT_FLOOR_MAX_AGE_MS);
      assert.equal(memberRequests(), 2 * BOT_FLOOR_MAX_PAGES);
      assert.equal((await readSeries(reopened, GUILD)).length, 4);
    } finally {
      await reopened.close();
    }
  });

  test('a stale successful floor followed by truncation waits before rescanning', async () => {
    const { rest, memberRequests } = pagedRest(guildPages(25_000));
    await recordReading(db, GUILD, {
      observedAt: '2026-08-24T10:00:00.000Z', presence: 41, botFloor: 22,
    });
    for (const observedAt of ['2026-08-25T10:00:00.000Z', '2026-08-25T11:00:00.000Z']) {
      const res = await runProbeCycle({
        db, rest, guildId: GUILD, now: () => observedAt, botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
      });
      assert.equal(res.botFloor, null);
    }
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES);
    assert.equal(await lastBotFloorAt(db, GUILD), '2026-08-24T10:00:00.000Z');
  });

  test('a later complete scan restores the successful-floor daily cadence', async () => {
    const pages = guildPages(25_000);
    const { rest, memberRequests } = pagedRest(pages);
    const start = Date.parse('2026-08-25T10:00:00.000Z');
    const cycle = (hour: number) => runProbeCycle({
      db, rest, guildId: GUILD,
      now: () => new Date(start + hour * PRESENCE_PROBE_INTERVAL_MS).toISOString(),
      botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    assert.equal((await cycle(0)).botFloor, null);
    pages.splice(0, pages.length, ...guildPages(107));
    assert.equal((await cycle(23)).botFloor, null);
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES);
    assert.equal((await cycle(24)).botFloor, 22);
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES + 1);
    assert.equal((await cycle(47)).botFloor, null);
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES + 1);
    assert.equal((await cycle(48)).botFloor, 22);
    assert.equal(memberRequests(), BOT_FLOOR_MAX_PAGES + 2);
    assert.deepEqual((await readSeries(db, GUILD)).map((r) => r.botFloor), [null, null, 22, null, 22]);
    assert.equal(await lastBotFloorAt(db, GUILD), '2026-08-27T10:00:00.000Z');
  });

  test('truncation for one guild does not defer another guild', async () => {
    const oversized = pagedRest(guildPages(25_000));
    const otherGuild = 'synthetic-other-guild';
    const other = pagedRest(guildPages(107), 27, otherGuild);
    const now = () => '2026-08-25T10:00:00.000Z';
    await runProbeCycle({
      db, rest: oversized.rest, guildId: GUILD, now, botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    const res = await runProbeCycle({
      db, rest: other.rest, guildId: otherGuild, now, botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    assert.equal(res.botFloor, 22);
    assert.equal(other.memberRequests(), 1);
  });

  test('legacy four-column inserts default to an unclassified scan, not a retry hold', async () => {
    await db.prepare(
      `INSERT INTO presence_probe (guild_id, observed_at, approximate_presence_count, bot_floor)
       VALUES (?, ?, ?, ?)`,
    ).run(GUILD, '2026-08-25T10:00:00.000Z', 41, null);
    const { rest, memberRequests } = pagedRest(guildPages(107));
    const res = await runProbeCycle({
      db, rest, guildId: GUILD, now: () => '2026-08-25T11:00:00.000Z',
      botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    assert.equal(res.botFloor, 22);
    assert.equal(memberRequests(), 1);
    assert.deepEqual((await readSeries(db, GUILD)).map((r) => r.botFloor), [null, 22]);
  });

  test('an unclassified null floor still retries on the next hourly cycle', async () => {
    // An empty listing is a read failure, not evidence of an oversized roster.
    const pages: RawMember[][] = [];
    const { rest, memberRequests } = pagedRest(pages);
    const cycle = (observedAt: string) => runProbeCycle({
      db, rest, guildId: GUILD, now: () => observedAt, botFloorMaxPages: BOT_FLOOR_MAX_PAGES,
    });
    assert.equal((await cycle('2026-08-25T10:00:00.000Z')).botFloor, null);
    pages.push(...guildPages(107));
    assert.equal((await cycle('2026-08-25T11:00:00.000Z')).botFloor, 22);
    assert.equal(memberRequests(), 2);
    assert.deepEqual((await readSeries(db, GUILD)).map((r) => r.botFloor), [null, 22]);
  });

  test('countBotFloor refuses to run without a ceiling', async () => {
    const { rest } = pagedRest(guildPages(107));
    // @ts-expect-error - the ceiling is required; this must not compile.
    await assert.rejects(countBotFloor(rest, GUILD));
    // Zero/NaN ceilings compile (the type is `number`) but are refused at
    // runtime - an unbounded scan by another name.
    await assert.rejects(countBotFloor(rest, GUILD, { maxPages: 0 }), /refuses an unbounded scan/);
    await assert.rejects(
      countBotFloor(rest, GUILD, { maxPages: Number.NaN }),
      /refuses an unbounded scan/,
    );
  });

  test('the trend window reads 15 days, not two years', async () => {
    // Two years of hourly readings: 17,520 rows for one guild.
    const start = Date.parse('2024-08-26T00:00:00.000Z');
    for (let h = 0; h < 24 * 730; h += 12) {
      await recordReading(db, GUILD, {
        observedAt: new Date(start + h * 3_600_000).toISOString(),
        presence: 27,
        botFloor: h === 0 ? 23 : null,
      });
    }
    const total = (
      await db
        .prepare('SELECT COUNT(*) AS n FROM presence_probe WHERE guild_id = ?')
        .get<{ n: string }>(GUILD)
    )?.n;
    assert.equal(Number(total), 1460); // every 12th hour, two years

    const now = new Date(start + 730 * 24 * 3_600_000).toISOString();
    const windowed = await readSeries(db, GUILD, {
      since: new Date(Date.parse(now) - 14 * 86_400_000).toISOString(),
    });
    const unwindowed = await readSeries(db, GUILD);
    assert.ok(
      windowed.length < unwindowed.length,
      `windowed (${windowed.length}) must read fewer rows than unbounded (${unwindowed.length})`,
    );
    assert.equal(windowed.length, 28); // 14 days x 2 readings/day
    console.log(
      `cost/trend-read: rows_total=${unwindowed.length} rows_windowed_14d=${windowed.length}`,
    );
  });
});

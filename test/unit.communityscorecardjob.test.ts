import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommunityClassifier,
  loadCommunityClassifierConfig,
} from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore, COMMUNITY_FACT_TYPES } from '../src/analytics/communityFacts.ts';
import { startCommunityScorecardJob } from '../src/jobs/communityScorecard.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const GUILD = 'guild-a';
const VERSION = 'community-test-v1';
const WEEK_START = '2026-08-31T00:00:00.000Z';
const WEEK_END = '2026-09-07T00:00:00.000Z';
let t: TestDb;
let facts: CommunityFactStore;

before(async () => {
  t = await openTestDb(import.meta.filename);
  facts = new CommunityFactStore(t.db, new CommunityClassifier(loadCommunityClassifierConfig({
    TWO_COMMUNITY_CLASSIFIER_VERSION: VERSION,
  })));
});
after(async () => t.cleanup());
beforeEach(async () => t.reset());

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('Monday job persists production coverage before scoring the closed week', async () => {
  const handle = startCommunityScorecardJob({
    db: t.db,
    guildId: GUILD,
    classifierVersion: VERSION,
    facts,
    captureStartedAt: WEEK_START,
    intervalMs: 60_000,
    now: () => new Date('2026-09-07T06:15:00.000Z'),
  });
  try {
    await settle();
    const rows = await t.db.prepare(
      `SELECT stream, covered_from, covered_through FROM community_stream_heartbeats WHERE guild_id = ? ORDER BY stream`,
    ).all<{ stream: string; covered_from: string; covered_through: string }>(GUILD);
    assert.equal(rows.length, COMMUNITY_FACT_TYPES.length);
    assert.deepEqual(new Set(rows.map((row) => row.stream)), new Set(COMMUNITY_FACT_TYPES));
    assert.equal(rows.every((row) => row.covered_from === WEEK_START && row.covered_through === WEEK_END), true);

    const run = await t.db.prepare(
      `SELECT coverage_state FROM community_scorecard_runs WHERE guild_id = ?`,
    ).get<{ coverage_state: string }>(GUILD);
    assert.equal(run?.coverage_state, 'complete');
  } finally {
    handle.stop();
  }
});

test('a process started inside the week makes the Monday job fail closed', async () => {
  const handle = startCommunityScorecardJob({
    db: t.db,
    guildId: GUILD,
    classifierVersion: VERSION,
    facts,
    captureStartedAt: '2026-09-03T00:00:00.000Z',
    intervalMs: 60_000,
    now: () => new Date('2026-09-07T06:15:00.000Z'),
  });
  try {
    await settle();
    const run = await t.db.prepare(
      `SELECT coverage_state, scorecard_json FROM community_scorecard_runs WHERE guild_id = ?`,
    ).get<{ coverage_state: string; scorecard_json: string }>(GUILD);
    assert.equal(run?.coverage_state, 'incomplete');
    assert.equal(JSON.parse(run!.scorecard_json).weeklyActiveHumans, null);
  } finally {
    handle.stop();
  }
});

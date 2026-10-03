/**
 * TOG-10015: real discord.js gateway/cache recovery, not emitted client events.
 * Cold/fresh GUILD_CREATE snapshots are observations, never measured starts;
 * Resume and Identify must both invalidate durations spanning a blind window.
 * All process configuration is fixture-owned; only the isolated test DB is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { LOBBY_VOICE_CHANNEL_ID } from '../src/onboarding/session.ts';
import { countUnknownStartsPerWindow, findBlindWindows, summarizeVoiceDurations } from '../src/core/voiceSessions.ts';
import { openTestDb, TEST_PG_URL } from './helpers/testDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const member = (n: number) => String(900000000000005000n + BigInt(n));
const CHANNEL_B = LOBBY_VOICE_CHANNEL_ID;

interface VoiceRow {
  event_type: string;
  source: string;
  metadata: string | null;
  occurred_at: string;
  recorded_at: string;
}
interface EndMetadata {
  startKnown: boolean;
  startedAt: string | null;
  durationSeconds: number | null;
}

function assertEnd(row: VoiceRow, channelId: string, known: boolean): EndMetadata {
  assert.equal(row.source, `channel:${channelId}`);
  const metadata = JSON.parse(row.metadata ?? '{}') as EndMetadata;
  assert.equal(metadata.startKnown, known);
  if (known) {
    assert.ok(metadata.startedAt && Number.isFinite(Date.parse(metadata.startedAt)));
    assert.ok(typeof metadata.durationSeconds === 'number' && metadata.durationSeconds >= 0);
  } else {
    assert.equal(metadata.startedAt, null);
    assert.equal(metadata.durationSeconds, null);
  }
  return metadata;
}

test('mock gateway voice lifecycle: cold snapshots, bursts, resume and fresh blind windows', { timeout: 90_000 }, async (t) => {
  const mock = await startMockDiscord({ voiceStates: [
    { memberId: member(1), channelId: '900000000000000011' },
    { memberId: member(2), channelId: '900000000000000011' },
    { memberId: member(3), channelId: '900000000000000011', isBot: true },
  ] });
  const harness = await openTestDb(import.meta.filename).catch(async (err) => {
    await mock.close();
    throw err;
  });
  const bot = spawn(process.execPath, ['src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Do not inherit credentials, transports, NODE_OPTIONS or optional services.
    env: {
      PATH: process.env.PATH,
      DISCORD_TOKEN: 'mock.token.value',
      DISCORD_API_BASE: mock.apiBase,
      DISCORD_GUILD_ID: mock.guildId,
      TWO_DATABASE_URL: TEST_PG_URL,
      PGOPTIONS: `-c search_path=${harness.schema}`,
      TWO_PRESENCE_PROBE: '0',
      TWO_COMMUNITY_RECOMMENDATIONS: '0',
      LOG_LEVEL: 'debug',
    },
  });
  const output: string[] = [];
  let exited = false;
  bot.stdout.on('data', (chunk) => output.push(String(chunk)));
  bot.stderr.on('data', (chunk) => output.push(String(chunk)));
  const stopped = once(bot, 'exit').then(() => { exited = true; });
  t.after(async () => {
    if (!exited) bot.kill('SIGKILL');
    await stopped;
    await mock.close();
    await harness.cleanup();
  });

  const logs = () => output.join('').split('\n').flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  async function waitFor<T>(label: string, read: () => Promise<T> | T, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      if (exited) break;
      await sleep(25);
    }
    throw new Error(`timed out: ${label}\n${output.join('')}`);
  }
  const rows = (id: string, type?: string) => harness.db.prepare(
    `SELECT event_type, source, metadata, occurred_at, recorded_at FROM events
     WHERE guild_id = ? AND member_id = ?${type ? ' AND event_type = ?' : ''} ORDER BY id`,
  ).all<VoiceRow>(mock.guildId, id, ...(type ? [type] : []));
  async function waitRows(id: string, type: string, count: number): Promise<VoiceRow[]> {
    return waitFor(`${type} ${id}: ${count} rows`, async () => {
      const result = await rows(id, type);
      return result.length >= count ? result : null;
    }) as Promise<VoiceRow[]>;
  }
  async function recover(mode: 'resume' | 'fresh', dropped: number) {
    const event = `voice_sessions_dropped_on_${mode === 'resume' ? 'resume' : 'fresh_session'}`;
    const before = logs().filter((row) => row.msg === event).length;
    const identifies = mock.identifies.length;
    const resumes = mock.gatewayOpcodes.filter((op) => op === 6).length;
    await mock.reconnect(mode);
    await waitFor(event, () => logs().filter((row) => row.msg === event).length === before + 1);
    const record = logs().filter((row) => row.msg === event).at(-1)!;
    assert.equal(record.dropped, dropped);
    assert.equal(mock.identifies.length, identifies + (mode === 'fresh' ? 1 : 0));
    assert.equal(mock.gatewayOpcodes.filter((op) => op === 6).length, resumes + (mode === 'resume' ? 1 : 0));
  }

  await mock.waitForReady();
  await waitFor('bot ready after GUILD_CREATE', () => logs().some((row) => row.msg === 'ready'));
  assert.equal(mock.identifies.length, 1);

  await t.test('cold snapshot leave is unknown, not a fabricated startup session', async () => {
    assert.equal((await rows(member(1))).length, 0);
    mock.voiceLeave(member(1));
    const [end] = await waitRows(member(1), 'voice_session_end', 1);
    assertEnd(end, mock.voiceChannelId, false);
    assert.equal((await rows(member(1), 'voice_session_start')).length, 0);
    assert.equal((await rows(member(1), 'first_voice_session')).length, 0);
  });

  await t.test('cold snapshot move ends unknown A, then measures B; snapshot bots stay excluded', async () => {
    mock.voiceJoin(member(2), CHANNEL_B);
    await waitRows(member(2), 'voice_session_start', 1);
    mock.voiceLeave(member(2));
    const ends = await waitRows(member(2), 'voice_session_end', 2);
    assertEnd(ends[0], mock.voiceChannelId, false);
    assertEnd(ends[1], CHANNEL_B, true);
    mock.voiceLeave(member(3), true);
    // A same-member known session is a write barrier for duplicate/no-boundary frames.
    mock.voiceJoin(member(2));
    await waitRows(member(2), 'voice_session_start', 2);
    mock.voiceLeave(member(2));
    await waitRows(member(2), 'voice_session_end', 3);
    assert.equal((await rows(member(3))).length, 0);
    assert.equal((await rows(member(2), 'first_voice_session')).length, 1);
  });

  await t.test('back-to-back join/move/duplicate/leave stays ordered and measured', async () => {
    mock.voiceJoin(member(4));
    mock.voiceJoin(member(4), CHANNEL_B);
    mock.voiceJoin(member(4), CHANNEL_B);
    mock.voiceLeave(member(4));
    const ends = await waitRows(member(4), 'voice_session_end', 2);
    assertEnd(ends[0], mock.voiceChannelId, true);
    const second = assertEnd(ends[1], CHANNEL_B, true);
    assert.equal(ends[0].occurred_at, second.startedAt, 'move halves share their boundary timestamp');
    assert.equal((await rows(member(4), 'voice_session_start')).length, 2);
    assert.equal((await rows(member(4), 'first_voice_session')).length, 1);
  });

  await t.test('guild removal while in voice closes exactly one known session', async () => {
    mock.memberJoin(member(5), 'matrix');
    await waitRows(member(5), 'member_join', 1);
    mock.voiceJoin(member(5));
    await waitRows(member(5), 'first_voice_session', 1);
    mock.memberRemove(member(5), 'matrix');
    await waitRows(member(5), 'member_leave', 1);
    const ends = await waitRows(member(5), 'voice_session_end', 1);
    assertEnd(ends[0], mock.voiceChannelId, true);
    assert.equal(ends.length, 1);
  });

  let resumeBefore: string;
  let resumeUnknown: VoiceRow;
  await t.test('opcode 7 / Resume invalidates both members; subsequent moves restore measurement', async () => {
    mock.voiceJoin(member(6));
    mock.voiceJoin(member(7));
    await waitRows(member(6), 'first_voice_session', 1);
    const [start] = await waitRows(member(7), 'voice_session_start', 1);
    await waitRows(member(7), 'first_voice_session', 1);
    resumeBefore = start.recorded_at;
    await recover('resume', 2);
    mock.voiceLeave(member(6));
    [resumeUnknown] = await waitRows(member(6), 'voice_session_end', 1);
    assertEnd(resumeUnknown, mock.voiceChannelId, false);
    mock.voiceJoin(member(7), CHANNEL_B);
    await waitRows(member(7), 'voice_session_start', 2);
    mock.voiceLeave(member(7));
    const ends = await waitRows(member(7), 'voice_session_end', 2);
    assertEnd(ends[0], mock.voiceChannelId, false);
    assertEnd(ends[1], CHANNEL_B, true);
    assert.equal((await rows(member(7), 'first_voice_session')).length, 1);
  });

  await t.test('opcode 9 false / Identify observes missed moves but invents no gap history', async () => {
    for (const n of [8, 9, 10]) mock.voiceJoin(member(n));
    for (const n of [8, 9, 10]) await waitRows(member(n), 'first_voice_session', 1);
    // Member 9 moved unseen; 10 left unseen; 11 joined unseen during the gap.
    mock.setVoiceStates([
      { memberId: member(8), channelId: mock.voiceChannelId },
      { memberId: member(9), channelId: CHANNEL_B },
      { memberId: member(11), channelId: mock.voiceChannelId },
    ]);
    await recover('fresh', 3);
    for (const n of [8, 9, 11]) mock.voiceLeave(member(n));
    for (const n of [8, 9, 11]) {
      const [end] = await waitRows(member(n), 'voice_session_end', 1);
      assertEnd(end, n === 9 ? CHANNEL_B : mock.voiceChannelId, false);
    }
    assert.equal((await rows(member(10), 'voice_session_end')).length, 0, 'unseen leave is not reconstructed');
    assert.equal((await rows(member(11), 'voice_session_start')).length, 0, 'unseen join is not reconstructed');
    assert.equal((await rows(member(9), 'voice_session_start')).length, 1, 'unseen move is not reconstructed');
  });

  await t.test('gateway unknown ends feed blind-window counts, never duration means', async () => {
    const windows = findBlindWindows([resumeBefore!, resumeUnknown!.recorded_at], 1);
    assert.equal(windows.length, 1, 'real recovery separates the persisted write timestamps');
    const ends = await rows(member(7), 'voice_session_end');
    const metadata = [resumeUnknown!, ...ends].map((row) => JSON.parse(row.metadata ?? '{}') as EndMetadata);
    const counted = countUnknownStartsPerWindow(windows, [resumeUnknown!, ...ends].map((row) => ({
      occurredAt: row.occurred_at,
      startKnown: (JSON.parse(row.metadata ?? '{}') as EndMetadata).startKnown,
    })));
    assert.equal(counted[0].unknownStarts, 2);
    const summary = summarizeVoiceDurations(metadata);
    assert.equal(summary.excludedUnknownStarts, 2);
    assert.equal(summary.measured, 1);
    assert.equal(summary.averageSeconds, metadata[2].durationSeconds);
  });
});

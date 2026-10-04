/**
 * TOG-8295: staging-verify stays green in CI without a Discord token.
 *
 * Runs the REAL scripts/staging-verify.ts as a child process against the
 * mock-Discord staging surface (tools/mock-discord/server.ts with
 * `stagingVerify: true`) plus a throwaway Postgres schema seeded with the
 * audit evidence the full sweep reconciles. The only credential is a fake
 * token built at runtime from the staging application id - the shape
 * checkStagingToken identifies, with no secret anywhere.
 *
 * Three slices, matching the script's own --case split:
 * - full sweep: every section incl. self-role panels and audit parity
 * - goodbye slice: the DB-free goodbye path, no audit preconditions
 * - temp-voice slice: the DB-free temp-voice structure path
 * Plus a live-token refusal: the LIVE application id must abort before any
 * network write, so a misconfigured CI env fails closed, not against Discord.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  LIVE_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';
import {
  MOCK_BOT_USER_ID,
  STAGING_VERIFY_BOT_ROLE_ID,
  STAGING_VERIFY_CHANNELS,
  STAGING_VERIFY_PANEL_MESSAGES,
  STAGING_VERIFY_ROLE_IDS,
  startMockDiscord,
  type MockDiscord,
} from '../tools/mock-discord/server.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/staging-verify.ts', import.meta.url));
const GUILD = TWO_STAGING_GUILD_ID;

// Shaped like a staging bot token so checkStagingToken identifies it; built
// at runtime so no token-shaped literal sits in the repo.
const fakeTokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.fake.fake`;

// Every panel mode the full sweep requires, each option pinned to the live
// mask '0' the mock serves, on the panel messages the mock answers. One
// exclusive panel and one exclusive color group, as the script demands.
function panelCatalog(): string {
  const general = STAGING_VERIFY_CHANNELS.general;
  return JSON.stringify([
    {
      id: 'verify-buttons',
      channelId: general,
      messageId: STAGING_VERIFY_PANEL_MESSAGES.buttons,
      mode: 'button',
      exclusive: false,
      color: false,
      options: [
        { key: 'mod', label: 'Moderator', roleId: STAGING_VERIFY_ROLE_IDS['Moderator'], permissions: '0' },
        { key: 'member', label: 'Member', roleId: STAGING_VERIFY_ROLE_IDS['Member'], permissions: '0' },
      ],
    },
    {
      id: 'verify-select',
      channelId: general,
      messageId: STAGING_VERIFY_PANEL_MESSAGES.select,
      mode: 'select',
      exclusive: true,
      color: false,
      options: [
        { key: 'test1', label: 'Game Test', roleId: STAGING_VERIFY_ROLE_IDS['Game: Test'], permissions: '0' },
        { key: 'test2', label: 'Game Test 2', roleId: STAGING_VERIFY_ROLE_IDS['Game: Test 2'], permissions: '0' },
      ],
    },
    {
      id: 'verify-reactions',
      channelId: general,
      messageId: STAGING_VERIFY_PANEL_MESSAGES.reactions,
      mode: 'reaction',
      exclusive: true,
      color: true,
      options: [
        { key: 'red', label: 'Red', roleId: STAGING_VERIFY_ROLE_IDS['Color: Red'], permissions: '0', emoji: '🟥' },
        { key: 'blue', label: 'Blue', roleId: STAGING_VERIFY_ROLE_IDS['Color: Blue'], permissions: '0', emoji: '🟦' },
      ],
    },
  ]);
}

// One durable row per audit-acceptance kind, all delivered into their accepted
// sinks; the moderation row doubles as the successful-moderation proof, and
// the tamper row proves sink-tamper evidence without a mirror.
const AUDIT_KINDS = [
  'message_edit',
  'message_delete',
  'member_update',
  'voice_join',
  'voice_leave',
  'voice_move',
  'moderation_action',
] as const;

function sinkFor(kind: string): string {
  if (kind === 'moderation_action') return STAGING_VERIFY_CHANNELS.moderationLog;
  if (kind.startsWith('voice_')) return STAGING_VERIFY_CHANNELS.voiceLog;
  return STAGING_VERIFY_CHANNELS.auditLog;
}

let mock: MockDiscord;
let harness: TestDb;
let schemaEnv: Record<string, string>;
let since: string;

before(async () => {
  mock = await startMockDiscord({ guildId: GUILD, stagingVerify: true });
  // The verifier reads the bot's own membership for the permission-mask and
  // goodbye slices; the mock reports whatever is seeded here.
  mock.setMemberRoles(MOCK_BOT_USER_ID, [STAGING_VERIFY_BOT_ROLE_ID]);

  harness = await openTestDb(import.meta.filename);
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  schemaEnv = {
    TWO_STAGING_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };

  // Markers the reconciliation reads back from channel history: the message
  // id is the durable mirror_message_id, the content carries the entry
  // identity the script matches on.
  since = new Date(Date.now() - 3_600_000).toISOString();
  const now = new Date().toISOString();
  const byChannel = new Map<string, Array<{ id: string; content: string; timestamp: string }>>();
  let n = 0;
  for (const kind of AUDIT_KINDS) {
    n += 1;
    const entryId = `tog8295-${kind}-${n}`;
    const channelId = sinkFor(kind);
    const messageId = `90000000000000008${n}`;
    const action = kind === 'moderation_action' ? 'moderation.slowmode' : null;
    const metadata =
      kind === 'moderation_action'
        ? JSON.stringify({ origin: 'moderation_service', auditLogEntryId: '900000000000000099' })
        : '{}';
    await harness.db
      .prepare(
        `INSERT INTO operational_audit_log
           (entry_id, event_kind, guild_id, occurred_at, action, metadata_json,
            mirror_channel_id, mirror_message_id, delivery_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?)`,
      )
      .run(entryId, kind, GUILD, now, action, metadata, channelId, messageId, now);
    const rows = byChannel.get(channelId) ?? [];
    rows.push({ id: messageId, content: `audit-event:${entryId}; · **${kind}** at ${now}`, timestamp: now });
    byChannel.set(channelId, rows);
  }
  await harness.db
    .prepare(
      `INSERT INTO operational_audit_log
         (entry_id, event_kind, guild_id, occurred_at, source_channel_id,
          metadata_json, delivery_state, created_at)
       VALUES (?, 'message_edit', ?, ?, ?, '{}', 'none', ?)`,
    )
    .run('tog8295-tamper-1', GUILD, now, STAGING_VERIFY_CHANNELS.auditLog, now);
  for (const [channelId, messages] of byChannel) mock.seedChannelHistory(channelId, messages);
});

after(async () => {
  await mock?.close();
  await harness?.cleanup();
});

interface RunOptions {
  token?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

async function runVerify({ token, args = [], env = {} }: RunOptions = {}) {
  const fullEnv: Record<string, string | undefined> = {
    ...process.env,
    CREDENTIALS_DIRECTORY: '',
    DISCORD_API_BASE: mock.apiBase,
    DISCORD_STAGING_BOT_TOKEN: token ?? fakeTokenFor(STAGING_BOT_APPLICATION_ID),
    DISCORD_STAGING_GUILD_ID: GUILD,
    DISCORD_GOODBYE_CHANNEL_IDS: STAGING_VERIFY_CHANNELS.general,
    TWO_TEMP_VOICE_CATEGORY_ID: STAGING_VERIFY_CHANNELS.tempVoiceCategory,
    TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID: STAGING_VERIFY_CHANNELS.tempVoiceGenerator,
    ...env,
  };
  for (const [key, value] of Object.entries(fullEnv)) if (value === undefined) delete fullEnv[key];
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env: fullEnv as NodeJS.ProcessEnv });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('full sweep passes on the mock transport with seeded audit evidence', async () => {
  const result = await runVerify({
    env: {
      ...schemaEnv,
      TWO_AUDIT_ACCEPTANCE_SINCE: since,
      TWO_SELF_ROLE_PANELS: panelCatalog(),
    },
  });
  assert.equal(result.code, 0, `staging-verify exited ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /0 fail/);
});

test('goodbye slice passes without audit preconditions', async () => {
  const result = await runVerify({ args: ['--case=goodbye'] });
  assert.equal(result.code, 0, `goodbye slice exited ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /goodbye resolves to #general/);
});

test('temp-voice slice passes without audit preconditions', async () => {
  const result = await runVerify({ args: ['--case=temp-voice'] });
  assert.equal(result.code, 0, `temp-voice slice exited ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /temp-voice generator is configured/);
});

test('live application token aborts before any Discord write', async () => {
  const writesBefore = mock.captured.length;
  const result = await runVerify({ token: fakeTokenFor(LIVE_BOT_APPLICATION_ID) });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /LIVE bot/);
  assert.equal(mock.captured.length, writesBefore, 'refused token must not reach the API');
});

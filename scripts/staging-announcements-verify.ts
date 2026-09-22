/** Read-only acceptance readback. Never migrates, posts or repairs anything. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { announcementsProofConfig, assertProofIdentity, parseAnnouncementsProof } from './staging-announcements-state.ts';

import { proofDiscordFetch } from './staging-discord-fetch.ts';

export async function verifyAnnouncementsProof(path: string): Promise<void> {
  const discordFetch = proofDiscordFetch({ onRateLimit: ms => console.log(`WAIT Discord 429: ${ms}ms before bounded retry`) });
  const { token, dbUrl } = announcementsProofConfig(process.env);
  const report = parseAnnouncementsProof(JSON.parse(await readFile(path, 'utf8')));
  assert.ok(report.checks.every(c => c.pass), 'proof report contains failures');
  const required = [
    'source.clean', 'identity.remote', 'permission.no-bypass', 'feed.public-fetch',
    'announcement.readback', 'announcement.replay', 'announcement.allowlist',
    'permission.discord-denial', 'permission.no-message', 'permission.listener-feed-add', 'permission.listener-lfg',
    'event.create-readback', 'event.update', 'event.cancel-readback', 'event.cancel-restart-replay', 'event.unknown', 'event.mapping',
    'rsvp.converges', 'lfg.signup-replay', 'lfg.full', 'lfg.update-readback', 'lfg.close-readback', 'lfg.closed',
    'feed.deduplicated', 'feed.readback', 'feed.unknown', 'feed.remove',
    'audit.internal', 'audit.announcements', 'hierarchy.not-applicable', 'cleanup.rows', 'cleanup.denied-channel', 'cleanup.event-terminal',
    ...report.messageIds.map(id => `cleanup.message.${id}`),
  ];
  for (const name of required) assert.ok(report.checks.some(c => c.name === name && c.pass), `missing proof check: ${name}`);
  assert.ok(report.messageIds.length >= 3, 'announcement, LFG and feed delivery IDs are required');
  async function get<T>(path: string, expected = 200): Promise<T> {
    const res = await discordFetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    assert.equal(res.status, expected, `Discord GET ${path}`);
    return await res.json() as T;
  }
  const application = await get<{ id: string }>('/oauth2/applications/@me');
  const guild = await get<{ id: string; name: string }>(`/guilds/${report.guildId}`);
  assertProofIdentity(application.id, guild);
  const channel = await get<{ guild_id: string }>(`/channels/${report.channelId}`);
  assert.equal(channel.guild_id, report.guildId);
  const event = await get<{ guild_id: string; creator_id: string; status: number; name: string }>(`/guilds/${report.guildId}/scheduled-events/${report.eventId}`);
  assert.equal(event.guild_id, report.guildId);
  assert.equal(event.creator_id, report.applicationId);
  assert.equal(event.status, 4);
  assert.ok(event.name.includes(`TOG-3845:${report.runId}`));
  for (const id of report.messageIds) await get(`/channels/${report.channelId}/messages/${id}`, 404);
  await get(`/channels/${report.deniedChannelId}`, 404);

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    // Read-only transaction, no openDb(): a mistyped/nonexistent proof cannot
    // initialize a fresh schema and produce a vacuous successful verification.
    await pool.query('BEGIN READ ONLY');
    const identity = (await pool.query('SELECT current_database() AS name')).rows[0];
    assert.equal(identity.name, 'two_bot_staging');
    await pool.query(`SET LOCAL search_path TO "${report.schema}"`);
    const mapping = await pool.query('SELECT guild_id, event_key, discord_event_id FROM internal_discord_events');
    assert.deepEqual(mapping.rows, [{ guild_id: report.guildId, event_key: `TOG-3845:${report.runId}:event`, discord_event_id: report.eventId }]);
    const audit = (await pool.query('SELECT action, outcome, code, status, reason, created_at FROM internal_action_log WHERE key_id = $1', [`proof-${report.runId}`])).rows;
    for (const [action, outcome] of [['announcement.post', 'posted'], ['announcement.post', 'replayed:posted'], ['event.upsert', 'created'], ['event.upsert', 'updated'], ['event.cancel', 'cancelled'], ['event.cancel', 'replayed:cancelled']]) {
      assert.ok(audit.some(r => r.action === action && r.outcome === outcome && r.status === 200), `missing durable audit: ${action}/${outcome}`);
    }
    assert.ok(audit.some(r => r.action === 'announcement.post' && r.code === 'discord_rejected' && r.reason === 'discord_403'), 'real permission refusal audit');
    assert.ok(audit.some(r => r.action === 'event.cancel' && r.code === 'action_not_allowed'), 'unknown event refusal audit');
    assert.ok(audit.every(r => Date.parse(r.created_at) >= Date.parse(report.startedAt) && Date.parse(r.created_at) <= Date.parse(report.finishedAt)), 'audit must belong to this proof window');
    const actions = (await pool.query('SELECT action, outcome FROM announcements_audit_log WHERE guild_id = $1', [report.guildId])).rows;
    for (const action of ['event.rsvp', 'lfg.create', 'lfg.signup', 'lfg.close', 'feed.create', 'feed.poll', 'feed.remove']) {
      assert.ok(actions.some(r => r.action === action), `missing announcements audit: ${action}`);
    }
    assert.ok(actions.some(r => r.action === 'feed.remove' && r.outcome === 'missing'), 'unknown feed refusal audit');
    for (const table of ['feed_relays', 'feed_deliveries', 'lfg_posts', 'lfg_signups', 'event_rsvps']) {
      assert.equal(Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n), 0, `unclean proof table ${table}`);
    }
    await pool.query('ROLLBACK');
  } finally { await pool.end(); }
  console.log(`PASS announcements readback: ${report.runId}; source SHA ${report.head}; cancelled event ${report.eventId}`);
  console.log('Scope: source-level staging proof, synthetic interaction actors, real REST/Postgres/public RSS. Not deployed-gateway or human-click proof.');
}

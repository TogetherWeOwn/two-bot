/**
 * Backup and restore, exercised as a round trip.
 *
 * An untested backup is not a backup, and "the script exited 0" is not a test
 * of a backup - it is a test of the script's happy path. What is asserted here
 * is the property that actually matters during a recovery: dump a database,
 * wipe it, restore it, and the contents are the same, including the things
 * that are easy to lose and hard to notice - the `events` id sequence, and the
 * idempotency keys that stop a join being counted twice.
 *
 * Run with TWO_TEST_DATABASE_URL pointing at an isolated Postgres database.
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { EventStore } from '../src/store/eventStore.ts';
import { dump, restore, DUMP_TABLES } from '../src/store/dump.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = 'guild-backup';

describe('backup round trip', () => {
  let harness: TestDb;
  let store: EventStore;
  let dir: string;

  before(async () => {
    harness = await openTestDb(import.meta.filename);
    store = new EventStore(harness.db);
    dir = mkdtempSync(join(tmpdir(), 'two-backup-'));
  });
  after(async () => {
    await harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await harness.reset();
  });

  /** A small but structurally complete database: events, projection, invites. */
  async function seed(members = 5): Promise<void> {
    for (let i = 0; i < members; i++) {
      const id = `m${i}`;
      await store.record({
        guildId: G,
        memberId: id,
        eventType: 'member_join',
        occurredAt: `2026-08-0${(i % 9) + 1}T10:00:00.000Z`,
        source: 'invite:abc',
      });
      if (i % 2 === 0) {
        await store.record({
          guildId: G,
          memberId: id,
          eventType: 'first_message',
          occurredAt: `2026-08-0${(i % 9) + 1}T10:00:30.000Z`,
          source: 'channel:general',
          metadata: { channelId: 'c1' },
        });
      }
    }
    await harness.db
      .prepare(
        `INSERT INTO invite_snapshots (guild_id, code, uses, inviter_id, channel_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'abc', 12, 'owner', 'c1', '2026-08-09T00:00:00.000Z');
    for (const at of ['2026-08-09T00:00:01.000Z', '2026-08-10T00:00:01.000Z']) {
      await harness.db.prepare(
        `INSERT INTO capture_pending_joins (guild_id, member_id, joined_at) VALUES (?, ?, ?)`,
      ).run(G, 'pending-member', at);
    }
    // TOG-1659 High 5: the moderation state must survive backup/restore the
    // same way the funnel does - a lost pending unban is a tempban that
    // became permanent.
    for (let i = 0; i < members; i++) {
      const req = `mod-seed-${i}`;
      await harness.db
        .prepare(
          `INSERT INTO moderation_audit
             (request_id, guild_id, actor_id, action, target_id, channel_id, reason,
              outcome, idempotency_key, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(req, G, 'staff', 'moderation.warn', `m${i}`, null, 'seed', 'warned', req, '{}', '2026-08-01T10:00:00.000Z');
      await harness.db
        .prepare(
          `INSERT INTO moderation_warnings
             (id, guild_id, user_id, actor_id, reason, request_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(`warn-${i}`, G, `m${i}`, 'staff', 'seed warn', req, '2026-08-01T10:00:00.000Z');
    }
    await harness.db
      .prepare(
        `INSERT INTO moderation_scheduled_unbans
           (guild_id, user_id, execute_at, reason, request_id, state, created_at, claimed_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(G, 'm1', '2026-08-02T10:00:00.000Z', 'expiry', 'mod-seed-unban-1', '2026-08-01T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO moderation_lockdowns
           (channel_id, guild_id, prior_allow, prior_deny, reason, locked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('chan-1', G, '1024', '8192', 'raid lockdown', '2026-08-01T11:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO moderation_idempotency
           (guild_id, idempotency_key, action, request_hash, state, outcome, result_json,
            claimed_at, completed_at)
         VALUES (?, ?, ?, ?, 'done', 'banned', '{}', ?, ?)`,
      )
      .run(G, 'mod-key-1', 'moderation.ban', 'deadbeef', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:01.000Z');
    await harness.db
      .prepare(
        `INSERT INTO containment_events
           (audit_entry_id, guild_id, executor_id, action, target_id, weight,
            occurred_at, state, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('audit-1', G, 'staff', 'channel.delete', 'channel-1', 3, '2026-08-01T12:00:00.000Z', 'contain', 'threshold crossed', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO containment_incidents
           (id, guild_id, executor_id, trigger_audit_entry_id, heat, state,
            result_json, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('incident-1', G, 'staff', 'audit-1', 5, 'contained', '{"removedRoleIds":["danger"]}', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:01.000Z');
    await harness.db
      .prepare(
        `INSERT INTO join_risk_flags
           (event_id, guild_id, member_id, account_created_at, joined_at, source, score,
            reasons_json, bulk_join_window, flagged, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('join-risk-1', G, 'm-risk', '2026-08-01T11:59:00.000Z', '2026-08-01T12:00:00.000Z', 'unknown', 3, '["new account"]', false, true, '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO operational_audit_log
           (entry_id, event_kind, guild_id, occurred_at, target_id, source_channel_id,
            message_id, metadata_json, created_at, mirror_channel_id, delivery_state,
            delivery_attempts, delivery_attempted_at, delivery_last_error,
            delivery_nonce, mirror_message_id, mirror_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'audit-backup-1',
        'message_delete',
        G,
        '2026-08-09T00:00:00.000Z',
        'm0',
        'c1',
        'message-1',
        '{"cached":false}',
        '2026-08-09T00:00:01.000Z',
        'audit-channel',
        'pending',
        1,
        '2026-08-09T00:00:02.000Z',
        'discord_send_failed',
        'audit-backup-1',
        null,
        '2026-08-09T00:00:03.000Z',
      );
    await harness.db
      .prepare(
        `INSERT INTO tickets (id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, 'closed', ?, ?)`,
      )
      .run('ticket-1', G, 'ticket-channel', 'm0', 'staff', '2026-08-09T01:00:00.000Z', '2026-08-09T02:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO ticket_transcripts
           (ticket_id, guild_id, channel_id, opener_id, claimed_by, content, message_count, created_at, purge_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ticket-1', G, 'ticket-channel', 'm0', 'staff', 'member asked for help', 1, '2026-08-09T02:00:00.000Z', '2026-11-07T02:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO automod_violations
           (guild_id, user_id, violation_count, last_filter, last_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'm1', 3, 'bad_words', 'automod-message-3', '2026-08-01T10:02:00.000Z');
    for (let i = 1; i <= 3; i++) {
      await harness.db
        .prepare(
          `INSERT INTO automod_processed_messages (guild_id, message_id, user_id, processed_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(G, `automod-message-${i}`, 'm1', `2026-08-01T10:0${i}:00.000Z`);
    }
    await harness.db.prepare(
      `INSERT INTO automation_commands
         (guild_id, name, description, template, text_trigger, enabled,
          created_by, created_at, updated_by, updated_at)
       VALUES (?, 'faq', 'FAQ', 'Read rules', '!faq', TRUE, 'staff', ?, 'staff', ?)`,
    ).run(G, '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z');
    await harness.db.prepare(
      `INSERT INTO scheduled_messages
         (id, guild_id, channel_id, body, next_run_at, interval_seconds, enabled,
          created_by, created_at, updated_by, updated_at)
       VALUES ('sched-1', ?, 'chan-1', 'scheduled', '2026-08-02T12:00:00.000Z', NULL, TRUE,
               'staff', '2026-08-01T12:00:00.000Z', 'staff', '2026-08-01T12:00:00.000Z')`,
    ).run(G);
    await harness.db.prepare(
      `INSERT INTO sticky_messages
         (guild_id, channel_id, body, debounce_seconds, enabled,
          created_by, created_at, updated_by, updated_at)
       VALUES (?, 'chan-1', 'sticky', 5, TRUE, 'staff', ?, 'staff', ?)`,
    ).run(G, '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z');
    await harness.db.prepare(
      `INSERT INTO automation_audit_log
         (id, guild_id, actor_id, action, target_key, outcome, reason, created_at)
       VALUES ('automation-audit-1', ?, 'staff', 'command.create', 'faq', 'ok', NULL, ?)`,
    ).run(G, '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO self_role_audit
           (event_id, event_order, guild_id, panel_id, member_id, source_id, option_key, role_id,
            source, operation, outcome, code, reason, added_role_ids, removed_role_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'self-role-event-1', '0000000000001:self-role-event-1', G, 'colors', 'm1',
        'panel-message', 'red', 'role-red', 'button', 'add', 'assigned', null, null,
        '["role-red"]', '[]', '2026-08-01T12:00:00.000Z',
      );
    await harness.db
      .prepare(
        `INSERT INTO self_role_panel_claims
           (guild_id, member_id, panel_id, claim_token, claim_generation, processing_expires_at,
            latest_event_id, latest_option_key, target_committed, latest_event_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        G, 'm1', 'colors', 'released-claim', 4, '2026-08-01T12:00:00.000Z',
        'self-role-event-1', 'red', true, '0000000000001:self-role-event-1',
      );
    // TOG-9074: everything below was silently omitted from the backup before
    // v4 - leveling, scorecard, settings, RSVP/LFG/feed, temp voice, and the
    // rest. One row per table keeps the round trip honest without slowing it.
    await harness.db
      .prepare(
        `INSERT INTO guild_counters (guild_id, human_member_count, human_member_count_at, online_count, online_count_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 120, '2026-08-09T00:00:00.000Z', null, null);
    await harness.db
      .prepare(
        `INSERT INTO counter_snapshots (guild_id, human_member_count, human_member_count_at, online_count, online_count_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 120, '2026-08-09T00:00:00.000Z', null, null);
    await harness.db
      .prepare(`UPDATE rank_ladder SET role_id = ? WHERE rank_key = 'soldier'`)
      .run('role-soldier');
    await harness.db
      .prepare(`INSERT INTO member_ranks (guild_id, member_id, rank_key, updated_at) VALUES (?, ?, ?, ?)`)
      .run(G, 'm1', 'soldier', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO rank_snapshots (guild_id, rank_key, member_count, holders_count, snapshot_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 'soldier', 10, 25, '2026-08-09T00:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO scheduled_events (guild_id, event_id, name, starts_at, channel_id, description, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'event-1', 'Game night', '2026-08-15T19:00:00.000Z', 'c1', 'weekly games', 'scheduled', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(`INSERT INTO member_exclusions (guild_id, member_id, reason, updated_at) VALUES (?, ?, ?, ?)`)
      .run(G, 'raid-1', 'raid', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO presence_probe (guild_id, observed_at, approximate_presence_count, bot_floor)
         VALUES (?, ?, ?, ?)`,
      )
      .run(G, '2026-08-09T00:00:00.000Z', 27, 23);
    await harness.db
      .prepare(`UPDATE web_contract_meta SET guild_id = ? WHERE singleton = TRUE`)
      .run(G);
    await harness.db
      .prepare(
        `INSERT INTO xp_awards (guild_id, member_id, source, xp, occurred_at, channel_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'm1', 'message', 5, '2026-08-01T10:00:00.000Z', 'c1');
    await harness.db
      .prepare(
        `INSERT INTO member_levels (guild_id, member_id, xp, message_xp, voice_xp, imported_xp, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'm1', 15, 5, 10, 0, '2026-08-01T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO xp_cooldowns (guild_id, member_id, source, last_awarded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(G, 'm1', 'message', '2026-08-01T10:00:00.000Z');
    await harness.db
      .prepare(`INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?)`)
      .run(G, 5, 'role-level-5');
    await harness.db
      .prepare(
        `INSERT INTO level_import_runs
           (guild_id, source, source_rows, unique_members, inserted, updated, unchanged,
            duplicate_rows, total_imported_xp, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'mee6', 100, 90, 80, 5, 5, 0, 8000, '2026-08-01T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO community_facts
           (guild_id, event_type, source_event_id, actor_id, occurred_at, recorded_at,
            source, classifier_version, classification, matched_rule, metadata, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        G, 'message_created', 'evt-1', 'm1', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:01.000Z',
        'collector', 'v3', 'eligible_human', 'human-rule', '{"channel":"c1"}', 'fact-key-1',
      );
    await harness.db
      .prepare(
        `INSERT INTO community_stream_heartbeats (guild_id, stream, covered_from, covered_through, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 'message_created', '2026-08-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO community_scorecard_runs
           (guild_id, week_start, week_end, classifier_version, watermark, input_count, input_hash,
            idempotency_key, revision, run_status, coverage_state, evidence_state,
            scorecard_json, intervention_code, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        G, '2026-07-27', '2026-08-03', 'v3', 42, 100, 'deadbeef',
        'run-key-1', 1, 'completed', 'complete', 'sufficient',
        '{"score":7}', 'NONE', '2026-08-03T00:00:00.000Z',
      );
    await harness.db
      .prepare(
        `INSERT INTO community_scorecard_alerts (guild_id, week_start, alert_key, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(G, '2026-07-27', 'drop-week-1', '2026-08-03T00:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, key, value, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'welcome.message', { text: 'hello' }, 3, '2026-08-01T12:00:00.000Z', 'admin-1');
    await harness.db
      .prepare(
        `INSERT INTO guild_settings_audit (guild_id, key, old_value, new_value, actor, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'welcome.message', null, { text: 'hello' }, 'admin-1', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO event_rsvps (guild_id, event_id, user_id, status, responded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 'event-1', 'm1', 'going', '2026-08-02T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO lfg_posts
           (id, guild_id, channel_id, message_id, title, starts_at, status, created_by, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('lfg-1', G, 'c1', 'msg-1', 'Dungeon run', '2026-08-15T19:00:00.000Z', 'open', 'm0', '2026-08-01T12:00:00.000Z', null);
    await harness.db
      .prepare(
        `INSERT INTO lfg_roles (lfg_id, role_key, label, slots, position)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('lfg-1', 'tank', 'Tank', 1, 0);
    await harness.db
      .prepare(`INSERT INTO lfg_signups (lfg_id, user_id, role_key, joined_at) VALUES (?, ?, ?, ?)`)
      .run('lfg-1', 'm1', 'tank', '2026-08-02T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO feed_relays
           (id, guild_id, channel_id, kind, source, enabled, last_checked_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('feed-1', G, 'c1', 'rss', 'https://example.com/feed', true, null, 'staff', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO feed_deliveries (feed_id, item_key, nonce, state, message_id, first_seen_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('feed-1', 'item-1', 'nonce-1', 'delivered', 'msg-2', '2026-08-02T10:00:00.000Z', '2026-08-02T10:01:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO temp_voice_channels
           (id, guild_id, channel_id, generator_id, category_id, owner_id, created_by, name,
            created_at, last_renamed_at, empty_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('vc-1', G, 'chan-vc-1', 'gen-1', 'cat-1', 'm1', 'm1', "m1's room", '2026-08-01T12:00:00.000Z', null, null);
    await harness.db
      .prepare(`INSERT INTO temp_voice_creates (guild_id, user_id, last_created_at) VALUES (?, ?, ?)`)
      .run(G, 'm1', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO temp_voice_audit (id, guild_id, actor_id, channel_id, action, outcome, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('vc-audit-1', G, 'm1', 'chan-vc-1', 'create', 'ok', null, '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO announcements_audit_log (id, guild_id, actor_id, action, target_key, outcome, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ann-1', G, 'staff', 'announce.post', 'feed-1', 'ok', null, '2026-08-02T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO invite_campaigns (slug, invite_code, label, disabled_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('launch-week', 'abc123', 'Launch week post', null, '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(`INSERT INTO audit_kill_switch (id, engaged_at, engaged_by) VALUES (?, ?, ?)`)
      .run(1, '2026-08-01T12:00:00.000Z', 'owner');
    await harness.db
      .prepare(
        `INSERT INTO internal_action_log
           (request_id, key_id, action, idempotency_key, outcome, code, status, reason, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('req-1', 'key-1', 'ping', 'idem-1', 'assigned', null, 200, 'ok', 5, '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO internal_discord_events (guild_id, event_key, discord_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 'evt-key-1', 'discord-1', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO internal_idempotency
           (key_id, idempotency_key, action, request_hash, state, outcome, result_json, claimed_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('key-1', 'idem-1', 'ping', 'deadbeef', 'done', 'ok', '{"pong":true}', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:01.000Z');
    await harness.db
      .prepare(`INSERT INTO internal_nonces (key_id, nonce, seen_at) VALUES (?, ?, ?)`)
      .run('key-1', 'nonce-1', '2026-08-01T12:00:00.000Z');
  }

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of DUMP_TABLES) {
      const r = await harness.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{ n: number }>();
      out[t] = Number(r?.n ?? 0);
    }
    return out;
  }

  test('a dump restores to the same contents', async () => {
    await seed();
    const before = await counts();
    const pendingSql = `SELECT guild_id, member_id, joined_at FROM capture_pending_joins
                        ORDER BY guild_id, member_id, joined_at`;
    const pending = await harness.db.prepare(pendingSql).all();
    const events = await harness.db
      .prepare(`SELECT id, event_type, occurred_at, idempotency_key FROM events ORDER BY id`)
      .all();
    const audit = await harness.db
      .prepare(
        `SELECT entry_id, event_kind, guild_id, occurred_at, target_id, source_channel_id,
                message_id, metadata_json, mirror_channel_id, delivery_state,
                delivery_attempts, delivery_attempted_at, delivery_last_error,
                delivery_nonce, mirror_message_id, mirror_checked_at
           FROM operational_audit_log ORDER BY entry_id`,
      )
      .all();
    const tickets = await harness.db
      .prepare(
        `SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at
           FROM tickets ORDER BY id`,
      )
      .all();
    const transcripts = await harness.db
      .prepare(
        `SELECT ticket_id, guild_id, channel_id, opener_id, claimed_by, content,
                message_count, created_at, purge_after
           FROM ticket_transcripts ORDER BY ticket_id`,
      )
      .all();

    const file = join(dir, 'roundtrip.ndjson.gz');
    const manifest = await dump(harness.db, file);
    assert.equal(manifest.tables.find((t) => t.name === 'events')?.count, before.events);
    assert.equal(manifest.tables.find((t) => t.name === 'capture_pending_joins')?.count, 2);
    assert.equal(manifest.tables.find((t) => t.name === 'operational_audit_log')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'tickets')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'ticket_transcripts')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'automod_violations')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'automod_processed_messages')?.count, 3);
    assert.equal(manifest.tables.find((t) => t.name === 'containment_events')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'containment_incidents')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'join_risk_flags')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'self_role_audit')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'self_role_panel_claims')?.count, 1);
    // TOG-9074: the tables the v3 backup silently omitted must be in the v4
    // manifest with their rows - one row each from seed().
    for (const name of [
      'guild_counters', 'counter_snapshots', 'member_ranks',
      'rank_snapshots', 'scheduled_events', 'member_exclusions',
      'presence_probe', 'web_contract_meta',
      'xp_awards', 'member_levels', 'xp_cooldowns',
      'level_role_rewards', 'level_import_runs',
      'community_facts', 'community_stream_heartbeats',
      'community_scorecard_runs', 'community_scorecard_alerts',
      'guild_settings', 'guild_settings_audit',
      'event_rsvps', 'lfg_posts', 'lfg_roles', 'lfg_signups',
      'feed_relays', 'feed_deliveries',
      'temp_voice_channels', 'temp_voice_creates', 'temp_voice_audit',
      'announcements_audit_log', 'invite_campaigns', 'audit_kill_switch',
      'internal_action_log', 'internal_discord_events',
      'internal_idempotency', 'internal_nonces',
    ] as const) {
      assert.equal(
        manifest.tables.find((t) => t.name === name)?.count, 1,
        `${name} is missing from the dump manifest - the backup silently drops it`,
      );
    }
    // rank_ladder carries only its five migration seed rows; the seed updates
    // one role_id rather than inserting.
    assert.equal(manifest.tables.find((t) => t.name === 'rank_ladder')?.count, 5);

    // Lose everything, exactly as a dead disk would.
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    assert.equal((await counts()).events, 0);
    // Restore replaces pending observations too; target-only rows must not leak
    // into a later capture and fabricate a join after recovery.
    await harness.db.prepare(
      `INSERT INTO capture_pending_joins (guild_id, member_id, joined_at) VALUES (?, ?, ?)`,
    ).run(G, 'target-only', '2026-08-11T00:00:01.000Z');

    const report = await restore(harness.db, file);
    assert.ok(report.ok, 'restore reported a count mismatch');
    assert.deepEqual(await counts(), before);
    assert.deepEqual(await harness.db.prepare(pendingSql).all(), pending);

    // Same rows, same ids, same order - not merely the same number of rows.
    const after = await harness.db
      .prepare(`SELECT id, event_type, occurred_at, idempotency_key FROM events ORDER BY id`)
      .all();
    assert.deepEqual(after, events);
    const restoredAudit = await harness.db
      .prepare(
        `SELECT entry_id, event_kind, guild_id, occurred_at, target_id, source_channel_id,
                message_id, metadata_json, mirror_channel_id, delivery_state,
                delivery_attempts, delivery_attempted_at, delivery_last_error,
                delivery_nonce, mirror_message_id, mirror_checked_at
           FROM operational_audit_log ORDER BY entry_id`,
      )
      .all();
    assert.deepEqual(restoredAudit, audit);
    const restoredTickets = await harness.db
      .prepare(
        `SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at
           FROM tickets ORDER BY id`,
      )
      .all();
    assert.deepEqual(restoredTickets, tickets);
    const restoredTranscripts = await harness.db
      .prepare(
        `SELECT ticket_id, guild_id, channel_id, opener_id, claimed_by, content,
                message_count, created_at, purge_after
           FROM ticket_transcripts ORDER BY ticket_id`,
      )
      .all();
    assert.deepEqual(restoredTranscripts, transcripts);
    const automod = await harness.db
      .prepare(`SELECT user_id, violation_count, last_message_id FROM automod_violations WHERE guild_id = ?`)
      .get(G);
    assert.deepEqual(automod, { user_id: 'm1', violation_count: 3, last_message_id: 'automod-message-3' });
    const processed = await harness.db
      .prepare(`SELECT message_id FROM automod_processed_messages WHERE guild_id = ? ORDER BY message_id`)
      .all<{ message_id: string }>(G);
    assert.deepEqual(processed.map((row) => row.message_id), [
      'automod-message-1', 'automod-message-2', 'automod-message-3',
    ]);

    // TOG-9074: spot-check the formerly-omitted tables by value, not just by
    // count - JSONB survival, the kill-switch row, and the FK chains.
    const setting = await harness.db
      .prepare(`SELECT key, value, version, updated_by FROM guild_settings WHERE guild_id = ?`)
      .get(G);
    assert.deepEqual({ ...setting }, {
      key: 'welcome.message', value: { text: 'hello' }, version: 3, updated_by: 'admin-1',
    });
    const killSwitch = await harness.db
      .prepare(`SELECT id, engaged_by FROM audit_kill_switch`)
      .get();
    assert.deepEqual({ ...killSwitch }, { id: 1, engaged_by: 'owner' });
    const signup = await harness.db
      .prepare(`SELECT l.user_id, r.label FROM lfg_signups l JOIN lfg_roles r
                ON r.lfg_id = l.lfg_id AND r.role_key = l.role_key`)
      .get();
    assert.deepEqual({ ...signup }, { user_id: 'm1', label: 'Tank' });
    const delivery = await harness.db
      .prepare(`SELECT state, message_id FROM feed_deliveries WHERE feed_id = 'feed-1'`)
      .get();
    assert.deepEqual({ ...delivery }, { state: 'delivered', message_id: 'msg-2' });
    const voice = await harness.db
      .prepare(`SELECT owner_id, name FROM temp_voice_channels WHERE id = 'vc-1'`)
      .get();
    assert.deepEqual({ ...voice }, { owner_id: 'm1', name: "m1's room" });
    const run = await harness.db
      .prepare(`SELECT intervention_code, evidence_state FROM community_scorecard_runs`)
      .get();
    assert.deepEqual({ ...run }, { intervention_code: 'NONE', evidence_state: 'sufficient' });
    const level = await harness.db
      .prepare(`SELECT xp, message_xp, voice_xp FROM member_levels WHERE guild_id = ?`)
      .get(G);
    assert.deepEqual({ ...level }, { xp: 15, message_xp: 5, voice_xp: 10 });
    const fact = await harness.db
      .prepare(`SELECT classification, matched_rule FROM community_facts`)
      .get();
    assert.deepEqual({ ...fact }, { classification: 'eligible_human', matched_rule: 'human-rule' });
    const ladder = await harness.db
      .prepare(`SELECT role_id FROM rank_ladder WHERE rank_key = 'soldier'`)
      .get();
    assert.equal(ladder?.role_id, 'role-soldier');
    const meta = await harness.db
      .prepare(`SELECT guild_id FROM web_contract_meta WHERE singleton = TRUE`)
      .get();
    assert.equal(meta?.guild_id, G);
  });

  test('the id sequence resumes past the restored rows', async () => {
    await seed();
    const file = join(dir, 'sequence.ndjson.gz');
    await dump(harness.db, file);
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    const max = await harness.db.prepare(`SELECT MAX(id) AS n FROM events`).get<{ n: number }>();

    // The write that would collide if setval had been forgotten.
    const r = await store.record({
      guildId: G,
      memberId: 'after-restore',
      eventType: 'member_join',
      occurredAt: '2026-08-20T10:00:00.000Z',
      source: 'invite:abc',
    });
    assert.equal(r.inserted, true);
    assert.ok(
      Number(r.eventId) > Number(max!.n),
      `new id ${r.eventId} should be past the restored max ${max!.n}`,
    );
  });

  test('every BIGSERIAL sequence resumes past its restored rows (TOG-9074)', async () => {
    await seed();
    const file = join(dir, 'sequences.ndjson.gz');
    const manifest = await dump(harness.db, file);
    assert.ok(Object.keys(manifest.sequences).length >= 6, 'expected a sequence mark per BIGSERIAL table');
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    // One direct insert per sequence table; each must land past the restored max.
    const cases: Array<{ table: string; sql: string; args: unknown[] }> = [
      {
        table: 'xp_awards',
        sql: `INSERT INTO xp_awards (guild_id, member_id, source, xp, occurred_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
        args: [G, 'after-restore', 'message', 5, '2026-08-20T10:00:00.000Z'],
      },
      {
        table: 'level_import_runs',
        sql: `INSERT INTO level_import_runs
                (guild_id, source, source_rows, unique_members, inserted, updated, unchanged,
                 duplicate_rows, total_imported_xp, imported_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [G, 'mee6', 10, 9, 8, 1, 0, 0, 800, '2026-08-20T10:00:00.000Z'],
      },
      {
        table: 'community_facts',
        sql: `INSERT INTO community_facts
                (guild_id, event_type, source_event_id, occurred_at, source,
                 classifier_version, classification, matched_rule, idempotency_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [G, 'message_created', 'evt-after', '2026-08-20T10:00:00.000Z', 'collector', 'v3', 'bot', 'bot-rule', 'fact-key-after'],
      },
      {
        table: 'community_scorecard_runs',
        sql: `INSERT INTO community_scorecard_runs
                (guild_id, week_start, week_end, classifier_version, watermark, input_count, input_hash,
                 idempotency_key, revision, run_status, coverage_state, evidence_state,
                 scorecard_json, intervention_code, generated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [G, '2026-08-03', '2026-08-10', 'v3', 43, 50, 'cafef00d', 'run-key-after', 1, 'completed', 'complete', 'sufficient', '{}', 'NONE', '2026-08-10T00:00:00.000Z'],
      },
      {
        table: 'guild_settings_audit',
        sql: `INSERT INTO guild_settings_audit (guild_id, key, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?) RETURNING id`,
        args: [G, 'welcome.message', { text: 'hello' }, { text: 'hi' }, 'admin-1'],
      },
    ];
    for (const c of cases) {
      const before = await harness.db.prepare(`SELECT MAX(id) AS n FROM ${c.table}`).get<{ n: number }>();
      const row = await harness.db.prepare(c.sql).get<{ id: number }>(...c.args);
      assert.ok(
        Number(row!.id) > Number(before!.n),
        `${c.table}: new id ${row!.id} should be past the restored max ${before!.n}`,
      );
    }
  });

  test('target-time rows do not survive a restore: no source/target mixing (TOG-9074)', async () => {
    await seed();
    const file = join(dir, 'nomix.ndjson.gz');
    await dump(harness.db, file);
    const sourceCounts = await counts();

    // Simulate a target that kept living after the backup was taken: extra
    // rows in both an old table and a formerly-undumped one.
    await harness.db
      .prepare(
        `INSERT INTO moderation_warnings (id, guild_id, user_id, actor_id, reason, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('warn-target-time', G, 'm9', 'staff', 'after backup', 'req-target', '2026-08-20T10:00:00.000Z');
    await harness.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, key, value, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'target.only', { v: 1 }, 1, '2026-08-20T10:00:00.000Z', 'admin-1');
    await harness.db
      .prepare(
        `INSERT INTO xp_awards (guild_id, member_id, source, xp, occurred_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(G, 'm9', 'voice', 7, '2026-08-20T10:00:00.000Z');

    const report = await restore(harness.db, file);
    assert.ok(report.ok, 'restore reported a count mismatch');
    assert.deepEqual(await counts(), sourceCounts, 'the restore must reproduce the source, not merge with the target');
    const stray = await harness.db
      .prepare(`SELECT key FROM guild_settings WHERE guild_id = ? AND key = 'target.only'`)
      .get(G);
    assert.equal(stray, undefined, 'a target-time settings row survived the restore');
  });

  test('idempotency survives the round trip, so a replayed join is still one join', async () => {
    await seed();
    const file = join(dir, 'idem.ndjson.gz');
    await dump(harness.db, file);
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    const before = (await counts()).events;
    // The same event the bot already recorded, re-delivered by Discord.
    const again = await store.record({
      guildId: G,
      memberId: 'm0',
      eventType: 'member_join',
      occurredAt: '2026-08-01T10:00:00.000Z',
      source: 'invite:abc',
    });
    assert.equal(again.inserted, false, 'a restored event was not recognised as already present');
    assert.equal((await counts()).events, before);
  });

  test('moderation durability survives the round trip: pending unbans, warn ledger, lockdown masks (TOG-1659 High 5)', async () => {
    await seed();
    const file = join(dir, 'moderation.ndjson.gz');
    const manifest = await dump(harness.db, file);
    const named = new Set(manifest.tables.map((t) => t.name));
    for (const t of [
      'moderation_warnings', 'moderation_scheduled_unbans', 'moderation_audit',
      'moderation_lockdowns', 'moderation_idempotency',
    ]) {
      assert.ok(named.has(t as never), `${t} is not in the dump manifest - losing it strands tempbans`);
    }

    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    const after = await counts();
    assert.equal(after.moderation_warnings, 5);
    assert.equal(after.moderation_audit, 5);
    assert.equal(after.moderation_scheduled_unbans, 1, 'the pending unban did not survive the restore');
    assert.equal(after.moderation_lockdowns, 1);
    assert.equal(after.moderation_idempotency, 1);

    const unban = await harness.db
      .prepare(`SELECT guild_id, user_id, execute_at, state FROM moderation_scheduled_unbans`)
      .get();
    assert.equal(unban?.state, 'pending');
    assert.equal(unban?.execute_at, '2026-08-02T10:00:00.000Z');

    const lockdown = await harness.db
      .prepare(`SELECT prior_allow, prior_deny FROM moderation_lockdowns WHERE channel_id = 'chan-1'`)
      .get();
    assert.equal(lockdown?.prior_allow, '1024');
    assert.equal(lockdown?.prior_deny, '8192');
  });

  test('automation durability survives backup and restore', async () => {
    await seed();
    const file = join(dir, 'automations.ndjson.gz');
    const manifest = await dump(harness.db, file);
    const named = new Set(manifest.tables.map((t) => t.name));
    for (const t of [
      'automation_commands', 'scheduled_messages', 'sticky_messages', 'automation_audit_log',
    ]) {
      assert.ok(named.has(t as never), `${t} is not in the dump manifest`);
    }

    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);
    const after = await counts();
    assert.equal(after.automation_commands, 1);
    assert.equal(after.scheduled_messages, 1);
    assert.equal(after.sticky_messages, 1);
    assert.equal(after.automation_audit_log, 1);
    const command = await harness.db
      .prepare(`SELECT name, text_trigger, enabled FROM automation_commands WHERE guild_id = ?`)
      .get(G);
    assert.equal(command?.name, 'faq');
    assert.equal(command?.text_trigger, '!faq');
    assert.equal(command?.enabled, true);
  });

  test('self-role committed target survives the round trip with its audit evidence', async () => {
    await seed();
    const file = join(dir, 'self-role-state.ndjson.gz');
    const manifest = await dump(harness.db, file);
    assert.equal(manifest.tables.find((t) => t.name === 'self_role_audit')?.count, 1);
    assert.equal(manifest.tables.find((t) => t.name === 'self_role_panel_claims')?.count, 1);

    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    const row = await harness.db
      .prepare(
        `SELECT event_id, guild_id, panel_id, member_id, source, operation, outcome,
                added_role_ids, removed_role_ids
           FROM self_role_audit`,
      )
      .get();
    assert.deepEqual({ ...row }, {
      event_id: 'self-role-event-1', guild_id: G, panel_id: 'colors', member_id: 'm1',
      source: 'button', operation: 'add', outcome: 'assigned',
      added_role_ids: '["role-red"]', removed_role_ids: '[]',
    });
    const claim = await harness.db
      .prepare(
        `SELECT latest_event_id, latest_option_key, target_committed, latest_event_order
           FROM self_role_panel_claims
          WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
      )
      .get(G, 'm1', 'colors');
    assert.deepEqual({ ...claim }, {
      latest_event_id: 'self-role-event-1',
      latest_option_key: 'red',
      target_committed: true,
      latest_event_order: '0000000000001:self-role-event-1',
    });
  });

  test('a truncated dump is refused rather than half-restored', async () => {
    await seed();
    const file = join(dir, 'whole.ndjson.gz');
    await dump(harness.db, file);

    // Chop the end marker off, which is what a full disk leaves behind.
    const lines = gunzipSync(readFileSync(file)).toString('utf8').trimEnd().split('\n');
    const cut = join(dir, 'truncated.ndjson.gz');
    writeFileSync(cut, gzipSync(lines.slice(0, -3).join('\n') + '\n'));

    const before = await counts();
    await assert.rejects(() => restore(harness.db, cut), /truncated|rows/i);
    // Untouched - but note this file is rejected by the reader, before a
    // transaction is ever opened. The rollback boundary itself is the next
    // test; this one only proves a short file cannot get that far.
    assert.deepEqual(await counts(), before);
  });

  test('a failure inside the restore transaction rolls the TRUNCATE back', async () => {
    await seed();
    const file = join(dir, 'clash-source.ndjson.gz');
    await dump(harness.db, file);

    const objs = gunzipSync(readFileSync(file))
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));

    // Duplicate one event under a new id but the same idempotency_key, and
    // adjust the manifest and end marker to match. The file is now internally
    // consistent, so every pre-transaction check passes and the failure lands
    // on the INSERT - after the TRUNCATE has already run. That is the only
    // arrangement that actually exercises the rollback.
    const sample = objs.find((o) => o.kind === 'row' && o.table === 'events');
    assert.ok(sample, 'expected the dump to contain at least one event row');
    const clash = {
      kind: 'row',
      table: 'events',
      data: { ...sample.data, id: Number(sample.data.id) + 100_000 },
    };

    for (const o of objs) {
      if (o.kind === 'manifest') {
        o.tables = o.tables.map((t: { name: string; count: number }) =>
          t.name === 'events' ? { ...t, count: t.count + 1 } : t,
        );
      } else if (o.kind === 'end') {
        o.rows += 1;
      }
    }
    objs.splice(
      objs.findIndex((o) => o.kind === 'end'),
      0,
      clash,
    );

    const bad = join(dir, 'clash.ndjson.gz');
    writeFileSync(bad, gzipSync(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));

    const before = await counts();
    assert.ok(before.events > 0, 'the rollback assertion is vacuous against an empty target');

    // Confirmed to be the INSERT that fails, not an earlier check: the error is
    // `duplicate key value violates unique constraint events_idempotency_key_key`.
    await assert.rejects(() => restore(harness.db, bad), /duplicate|unique|idempotency/i);
    assert.deepEqual(
      await counts(),
      before,
      'the TRUNCATE must have rolled back with the failed INSERT',
    );
  });

  test('an incomplete current-version dump is refused before it can erase audit data', async () => {
    await seed();
    const file = join(dir, 'incomplete-source.ndjson.gz');
    await dump(harness.db, file);
    const objs = gunzipSync(readFileSync(file))
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const manifest = objs.find((obj) => obj.kind === 'manifest');
    manifest.tables = manifest.tables.filter((table: { name: string }) => table.name !== 'operational_audit_log');
    const removedRows = objs.filter((obj) => obj.kind === 'row' && obj.table === 'operational_audit_log').length;
    const kept = objs.filter((obj) => !(obj.kind === 'row' && obj.table === 'operational_audit_log'));
    kept.find((obj) => obj.kind === 'end').rows -= removedRows;
    const incomplete = join(dir, 'incomplete.ndjson.gz');
    writeFileSync(incomplete, gzipSync(kept.map((obj) => JSON.stringify(obj)).join('\n') + '\n'));

    const before = await counts();
    const auditBefore = await harness.db
      .prepare(`SELECT entry_id, delivery_state FROM operational_audit_log ORDER BY entry_id`)
      .all();
    await assert.rejects(() => restore(harness.db, incomplete), /missing tables: operational_audit_log/);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(
      await harness.db.prepare(`SELECT entry_id, delivery_state FROM operational_audit_log ORDER BY entry_id`).all(),
      auditBefore,
    );
  });

  test('a dump naming a table the bot does not own is refused', async () => {
    await seed();
    const file = join(dir, 'foreign-source.ndjson.gz');
    await dump(harness.db, file);

    const objs = gunzipSync(readFileSync(file))
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));

    // What a crafted backup looks like: a table that is not ours, carried in
    // the manifest so the restore would truncate-and-insert it like one of the
    // bot's own. DUMP_TABLES is the boundary; this proves it is enforced on the
    // read path and not just on the write path.
    const manifest = objs.find((o) => o.kind === 'manifest');
    manifest.tables.push({ name: 'website_users', columns: ['id'], count: 1 });
    objs.splice(
      objs.findIndex((o) => o.kind === 'end'),
      0,
      { kind: 'row', table: 'website_users', data: { id: 1 } },
    );
    objs.find((o) => o.kind === 'end').rows += 1;

    const bad = join(dir, 'foreign.ndjson.gz');
    writeFileSync(bad, gzipSync(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));

    const before = await counts();
    await assert.rejects(() => restore(harness.db, bad), /website_users|does not own|not a table/i);
    assert.deepEqual(await counts(), before, 'a refused dump must not have truncated anything');
  });

  test('an empty database dumps and restores without inventing rows', async () => {
    const file = join(dir, 'empty.ndjson.gz');
    const manifest = await dump(harness.db, file);
    assert.equal(manifest.tables.find((t) => t.name === 'events')?.count, 0);

    const report = await restore(harness.db, file);
    assert.ok(report.ok);
    assert.equal((await counts()).events, 0);
  });
});

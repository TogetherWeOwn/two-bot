import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_TABLES } from '../src/store/webRoleCheck.ts';

test('website-role named denial inventory keeps every private table', () => {
  assert.deepEqual(BOT_TABLES, [
    'events', 'members', 'invite_snapshots', 'schema_migrations',
    'internal_nonces', 'internal_idempotency', 'internal_action_log', 'internal_discord_events',
    'moderation_warnings', 'moderation_scheduled_unbans', 'moderation_audit',
    'moderation_lockdowns', 'moderation_idempotency', 'automod_violations',
    'automod_processed_messages', 'containment_events', 'containment_incidents',
    'join_risk_flags', 'tickets', 'ticket_transcripts', 'member_levels',
    'xp_cooldowns', 'xp_awards', 'level_role_rewards', 'level_import_runs',
    'self_role_audit', 'self_role_panel_claims', 'web_contract_meta',
    'guild_counters', 'rank_ladder', 'rank_snapshots', 'member_ranks',
    'scheduled_events', 'presence_probe', 'counter_snapshots',
    'member_exclusions', 'invite_campaigns',
  ]);
});

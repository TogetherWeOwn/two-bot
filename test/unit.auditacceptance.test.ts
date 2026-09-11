import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ACCEPTANCE_KINDS,
  auditAcceptanceSql,
  auditMarkerRowsSql,
  evaluateAuditChannels,
  evaluateAuditEvidence,
  evaluateAuditMarkers,
} from '../src/staging/auditAcceptance.ts';
import { staffLogOverwrites } from '../src/staging/provision.ts';

const GUILD = '1545644954272137297';
const DENY_VIEW = String(1n << 10n);
const ALLOW_VIEW = String(1n << 10n);

const channel = (
  name: string,
  opts: { id?: string; deny?: string; extra?: Array<{ id: string; type?: number; allow?: string; deny: string }> } = {},
) => ({
  id: opts.id ?? `id-${name}`,
  name,
  type: 0,
  permission_overwrites: [
    { id: GUILD, deny: opts.deny ?? DENY_VIEW },
    ...(opts.extra ?? []),
  ],
});

test('all accepted log channels must be unique and deny member visibility', () => {
  assert.deepEqual(
    evaluateAuditChannels(
      [channel('audit-log'), channel('voice-log'), channel('moderation-log')],
      GUILD,
    ),
    {
      missing: [], memberReadable: [], duplicates: [],
      channelIds: { audit: 'id-audit-log', voice: 'id-voice-log', moderation: 'id-moderation-log' },
    },
  );
});

test('missing, duplicated, or member-readable log channels fail the privacy gate', () => {
  assert.deepEqual(
    evaluateAuditChannels(
      [
        channel('audit-log'),
        channel('audit-log', { id: 'duplicate-audit' }),
        channel('voice-log', { deny: '0' }),
      ],
      GUILD,
    ),
    {
      missing: ['moderation-log'],
      memberReadable: ['voice-log'],
      duplicates: ['audit-log'],
      channelIds: { audit: null, voice: null, moderation: null },
    },
  );
});

test('the provisioned bot overwrite is private while every other ViewChannel allow fails', () => {
  const botId = '900000000000000099';
  const provisioned = (name: string) => ({
    id: `id-${name}`,
    name,
    type: 0,
    permission_overwrites: staffLogOverwrites(GUILD, botId),
  });
  assert.deepEqual(
    evaluateAuditChannels(
      [provisioned('audit-log'), provisioned('voice-log'), provisioned('moderation-log')],
      GUILD,
      botId,
    ),
    {
      missing: [], memberReadable: [], duplicates: [],
      channelIds: { audit: 'id-audit-log', voice: 'id-voice-log', moderation: 'id-moderation-log' },
    },
  );

  for (const unsafe of [
    { id: botId, type: 0, allow: ALLOW_VIEW, deny: '0' },
    { id: botId, allow: ALLOW_VIEW, deny: '0' },
    { id: 'other-member', type: 1, allow: ALLOW_VIEW, deny: '0' },
    { id: 'staff-role', type: 0, allow: ALLOW_VIEW, deny: '0' },
  ]) {
    const roleAllow = evaluateAuditChannels(
      [
        { ...provisioned('audit-log'), permission_overwrites: [...staffLogOverwrites(GUILD, botId), unsafe] },
        provisioned('voice-log'),
        provisioned('moderation-log'),
      ],
      GUILD,
      botId,
    );
    assert.deepEqual(roleAllow.memberReadable, ['audit-log']);
  }
});

test('a role or member ViewChannel allow fails even when @everyone is denied', () => {
  const result = evaluateAuditChannels(
    [
      channel('audit-log', { extra: [{ id: 'member-or-role', allow: ALLOW_VIEW, deny: '0' }] }),
      channel('voice-log'),
      channel('moderation-log'),
    ],
    GUILD,
  );
  assert.deepEqual(result.memberReadable, ['audit-log']);
});

test('acceptance evidence requires every kind, unique entry ids and completed mirrors', () => {
  const rows = AUDIT_ACCEPTANCE_KINDS.map((event_kind) => ({
    event_kind,
    rows: 1,
    distinct_entries: 1,
    incomplete_deliveries: 0,
    sink_tamper_rows: event_kind === 'message_delete' ? 1 : 0,
    successful_moderation_rows: event_kind === 'moderation_action' ? 1 : 0,
  }));
  assert.deepEqual(evaluateAuditEvidence(rows), {
    missing: [], duplicates: [], pendingDeliveries: [],
    missingSinkTamper: false, missingModerationSuccess: false,
  });

  assert.deepEqual(evaluateAuditEvidence(rows.slice(1)).missing, ['message_edit']);
  const duplicate = rows.map((row) => row.event_kind === 'message_delete' ? { ...row, rows: 2 } : row);
  assert.deepEqual(evaluateAuditEvidence(duplicate).duplicates, ['message_delete']);
  const pending = rows.map((row) => row.event_kind === 'voice_move' ? { ...row, incomplete_deliveries: 1 } : row);
  assert.deepEqual(evaluateAuditEvidence(pending).pendingDeliveries, ['voice_move']);
  const none = rows.map((row) => row.event_kind === 'member_update' ? { ...row, incomplete_deliveries: 1 } : row);
  assert.deepEqual(evaluateAuditEvidence(none).pendingDeliveries, ['member_update']);
  const refusalOnly = rows.map((row) => row.event_kind === 'moderation_action'
    ? { ...row, successful_moderation_rows: 0 }
    : row);
  assert.equal(evaluateAuditEvidence(refusalOnly).missingModerationSuccess, true);
});

test('acceptance SQL enumerates every logging parity event and binds tamper to private sinks', () => {
  const since = '2026-09-09T00:00:00.000Z';
  const sql = auditAcceptanceSql(GUILD, since, ['audit-private', 'voice-private', 'moderation-private']);
  assert.match(sql, new RegExp(GUILD));
  assert.match(sql, new RegExp(since.replaceAll('.', '\\.')));
  for (const kind of AUDIT_ACCEPTANCE_KINDS) assert.match(sql, new RegExp(kind));
  assert.match(sql, /COUNT\(DISTINCT entry_id\)/);
  assert.match(sql, /delivery_state <> 'delivered'/);
  assert.match(sql, /event_kind = 'moderation_action' AND mirror_channel_id IS NOT NULL AND delivery_state = 'delivered'/);
  assert.match(sql, /metadata_json LIKE '%\"auditLogEntryId\":%'/);
  assert.match(sql, /action IN \('moderation\.ban'.*'moderation\.slowmode'/);
  assert.doesNotMatch(sql, /action IN \([^)]*moderation\.warn/);
  assert.match(sql, /source_channel_id IN \('audit-private', 'voice-private', 'moderation-private'\)/);
  const markerSql = auditMarkerRowsSql(GUILD, since);
  assert.match(markerSql, /SELECT entry_id, event_kind, mirror_channel_id, mirror_message_id/);
});

test('Discord marker reconciliation requires the expected private sink and exact message id', () => {
  assert.deepEqual(evaluateAuditMarkers([
    { entryId: 'ok', eventKind: 'message_edit', mirrorMessageId: 'm1', channelId: 'audit', expectedChannelId: 'audit', messageIds: ['m1'] },
    { entryId: 'missing', eventKind: 'voice_join', mirrorMessageId: 'm2', channelId: 'voice', expectedChannelId: 'voice', messageIds: [] },
    { entryId: 'duplicate', eventKind: 'voice_move', mirrorMessageId: 'm3', channelId: 'voice', expectedChannelId: 'voice', messageIds: ['m3', 'm4'] },
    { entryId: 'wrong-id', eventKind: 'moderation_action', mirrorMessageId: 'm5', channelId: 'moderation', expectedChannelId: 'moderation', messageIds: ['m6'] },
    { entryId: 'public', eventKind: 'message_delete', mirrorMessageId: 'm7', channelId: 'general', expectedChannelId: 'audit', messageIds: ['m7'] },
    { entryId: 'wrong-private', eventKind: 'voice_leave', mirrorMessageId: 'm8', channelId: 'audit', expectedChannelId: 'voice', messageIds: ['m8'] },
  ]), {
    missing: ['missing'],
    duplicates: ['duplicate'],
    messageIdMismatches: ['wrong-id'],
    channelMismatches: ['public', 'wrong-private'],
  });
});

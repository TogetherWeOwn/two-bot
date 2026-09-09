import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ACCEPTANCE_KINDS,
  auditAcceptanceSql,
  evaluateAuditChannels,
  evaluateAuditEvidence,
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
    { missing: [], memberReadable: [], duplicates: [] },
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
    { missing: [], memberReadable: [], duplicates: [] },
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
    pending_deliveries: 0,
  }));
  assert.deepEqual(evaluateAuditEvidence(rows), { missing: [], duplicates: [], pendingDeliveries: [] });

  assert.deepEqual(evaluateAuditEvidence(rows.slice(1)).missing, ['message_edit']);
  const duplicate = rows.map((row) => row.event_kind === 'message_delete' ? { ...row, rows: 2 } : row);
  assert.deepEqual(evaluateAuditEvidence(duplicate).duplicates, ['message_delete']);
  const pending = rows.map((row) => row.event_kind === 'voice_move' ? { ...row, pending_deliveries: 1 } : row);
  assert.deepEqual(evaluateAuditEvidence(pending).pendingDeliveries, ['voice_move']);
});

test('acceptance SQL enumerates every logging parity event and the staging guild', () => {
  const since = '2026-09-09T00:00:00.000Z';
  const sql = auditAcceptanceSql(GUILD, since);
  assert.match(sql, new RegExp(GUILD));
  assert.match(sql, new RegExp(since.replaceAll('.', '\\.')));
  for (const kind of AUDIT_ACCEPTANCE_KINDS) assert.match(sql, new RegExp(kind));
  assert.match(sql, /COUNT\(DISTINCT entry_id\)/);
  assert.match(sql, /pending_deliveries/);
});

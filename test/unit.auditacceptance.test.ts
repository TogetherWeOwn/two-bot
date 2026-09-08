import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ACCEPTANCE_KINDS,
  auditAcceptanceSql,
  evaluateAuditChannels,
} from '../src/staging/auditAcceptance.ts';

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

test('acceptance SQL enumerates every logging parity event and the staging guild', () => {
  const sql = auditAcceptanceSql(GUILD);
  assert.match(sql, new RegExp(GUILD));
  for (const kind of AUDIT_ACCEPTANCE_KINDS) assert.match(sql, new RegExp(kind));
  assert.match(sql, /COUNT\(DISTINCT entry_id\)/);
});

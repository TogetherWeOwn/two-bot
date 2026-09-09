import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatContainmentAlert, formatJoinRiskAlert } from '../src/discord/containmentAlert.ts';

test('containment alert names confirmed action and restore boundary', () => {
  const text = formatContainmentAlert({
    kind: 'containment',
    guildId: '1545644954272137297',
    executorId: '111111111111111111',
    action: 'channel.delete',
    targetId: '222222222222222222',
    heat: 6,
    threshold: 5,
    outcome: 'contained',
    removedRoleIds: ['333333333333333333'],
    restore: { outcome: 'restore_required', operations: 2 },
  });
  assert.match(text, /Anti-nuke contained/);
  assert.match(text, /Removed dangerous roles/);
  assert.match(text, /2 additive operation/);
  assert.match(text, /No member join was kicked or banned/);
});

test('join risk alert states the refusal boundary', () => {
  const text = formatJoinRiskAlert({
    guildId: '1545644954272137297',
    memberId: '111111111111111111',
    score: 3,
    reasons: ['account younger than 24 hours'],
    bulkJoinWindow: false,
  });
  assert.match(text, /Flag only/);
  assert.match(text, /did not kick, ban, timeout, or message/);
});

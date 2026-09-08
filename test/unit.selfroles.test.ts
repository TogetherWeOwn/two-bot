import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSelfRolePanels, SelfRoleConfigError } from '../src/selfRoles/config.ts';
import {
  emojiIdentity,
  parseSelfRoleCustomId,
  planSelfRoleChange,
  reactionEndpointEmoji,
  reactionOptionKey,
  selfRoleCustomId,
} from '../src/selfRoles/plan.ts';
import type { SelfRolePanel } from '../src/selfRoles/types.ts';
import { SelfRoleStore } from '../src/store/selfRoleStore.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';
const panel: SelfRolePanel = {
  id: 'colors',
  channelId: A,
  messageId: B,
  mode: 'button',
  exclusive: true,
  color: true,
  options: [
    { key: 'red', label: 'Red', roleId: A, emoji: '🔴' },
    { key: 'blue', label: 'Blue', roleId: B, emoji: '🔵' },
  ],
};

let harness: TestDb;
before(async () => { harness = await openTestDb(import.meta.filename); });
after(async () => { await harness.cleanup(); });
beforeEach(async () => { await harness.reset(); });

test('multiple panels and all three picker modes parse from deployment config', () => {
  const parsed = loadSelfRolePanels(JSON.stringify([
    panel,
    { ...panel, id: 'games', messageId: C, mode: 'select', exclusive: false, color: false },
    { ...panel, id: 'alerts', messageId: '444444444444444444', mode: 'reaction', exclusive: false, color: false },
  ]));
  assert.deepEqual(parsed.map((p) => p.mode), ['button', 'select', 'reaction']);
});

test('configuration rejects duplicate panels, messages, roles, and unsafe color semantics', () => {
  const duplicateMessage = JSON.stringify([panel, { ...panel, id: 'other' }]);
  assert.throws(() => loadSelfRolePanels(duplicateMessage), SelfRoleConfigError);
  assert.throws(
    () => loadSelfRolePanels(JSON.stringify([{ ...panel, exclusive: false }])),
    /color requires exclusive=true/,
  );
  assert.throws(
    () => loadSelfRolePanels(JSON.stringify([{ ...panel, options: [...panel.options, { key: 'green', label: 'Green', roleId: A }] }])),
    /offers role .* more than once/,
  );
});

test('exclusive color selection removes old colors and adds exactly one new color', () => {
  assert.deepEqual(
    planSelfRoleChange({ panel, optionKey: 'blue', memberRoleIds: [A], source: 'button', remove: false }),
    {
      ok: true,
      option: panel.options[1],
      operation: 'replace',
      addRoleIds: [B],
      removeRoleIds: [A],
      outcome: 'switched',
    },
  );
});

test('button toggles and reaction removal are idempotent', () => {
  const held = planSelfRoleChange({ panel, optionKey: 'red', memberRoleIds: [A], source: 'button', remove: false });
  assert.ok(held.ok);
  assert.equal(held.outcome, 'already_held');
  const reactionPanel = { ...panel, mode: 'reaction' as const, exclusive: false, color: false };
  const absent = planSelfRoleChange({ panel: reactionPanel, optionKey: 'red', memberRoleIds: [], source: 'reaction', remove: true });
  assert.ok(absent.ok);
  assert.equal(absent.outcome, 'already_absent');
});

test('a control cannot cross panel mode and unknown options are rejected', () => {
  assert.deepEqual(
    planSelfRoleChange({ panel, optionKey: 'red', memberRoleIds: [], source: 'select', remove: false }),
    { ok: false, code: 'wrong_source', reason: 'panel colors expects button, received select' },
  );
  assert.equal(planSelfRoleChange({ panel, optionKey: 'green', memberRoleIds: [], source: 'button', remove: false }).ok, false);
});

test('custom ids and reaction emoji resolve only configured panel options', () => {
  assert.equal(selfRoleCustomId('colors', 'red'), 'two:self-role:colors:red');
  assert.deepEqual(parseSelfRoleCustomId('two:self-role:colors:red'), { panelId: 'colors', optionKey: 'red' });
  assert.equal(parseSelfRoleCustomId('two:self-role:Colors:red'), null);
  assert.equal(reactionOptionKey({ ...panel, mode: 'reaction' }, { id: null, name: '🔵' }), 'blue');
  assert.equal(reactionOptionKey({ ...panel, mode: 'reaction' }, { id: null, name: '🟢' }), null);

  const custom = '<:red:555555555555555555>';
  const customPanel = {
    ...panel,
    mode: 'reaction' as const,
    options: [{ ...panel.options[0], emoji: custom }],
  };
  assert.equal(emojiIdentity(custom), '555555555555555555');
  assert.equal(reactionEndpointEmoji(custom), 'red:555555555555555555');
  assert.equal(reactionOptionKey(customPanel, { id: '555555555555555555', name: 'red' }), 'red');
});

test('audit claims dedupe gateway deliveries before the final outcome is stored', async () => {
  const store = new SelfRoleStore(harness.db);
  const row = {
    eventId: 'event-1', guildId: A, panelId: panel.id, memberId: B, sourceId: panel.messageId,
    optionKey: 'red', roleId: A, source: 'button' as const, operation: 'add' as const,
    outcome: 'assigned' as const, code: null, reason: null, addedRoleIds: [A], removedRoleIds: [],
  };
  assert.equal(await store.claimAudit(row), true);
  assert.equal(await store.claimAudit(row), false);
  await store.finishAudit(row);
  const stored = await harness.db
    .prepare(`SELECT COUNT(*) AS n, MAX(outcome) AS outcome FROM self_role_audit WHERE panel_id = ?`)
    .get<{ n: number; outcome: string }>(panel.id);
  assert.equal(Number(stored?.n), 1);
  assert.equal(stored?.outcome, 'assigned');
});

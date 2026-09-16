import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentType } from 'discord.js';
import { buildSelfRoleComponents } from '../src/discord/selfRoles.ts';
import type { SelfRolePanel } from '../src/selfRoles/types.ts';

const panel: SelfRolePanel = {
  id: 'games',
  channelId: '111111111111111111',
  messageId: '222222222222222222',
  mode: 'select',
  exclusive: false,
  color: false,
  options: [
    { key: 'one', label: 'One', roleId: '333333333333333333', permissions: '0', description: 'First' },
    { key: 'two', label: 'Two', roleId: '444444444444444444', permissions: '0', emoji: '🎮' },
  ],
};

test('select panels expose all roles and reflect current selections', () => {
  const json = buildSelfRoleComponents(panel, [panel.options[1].roleId])[0].toJSON();
  assert.equal(json.components[0].type, ComponentType.StringSelect);
  const component = json.components[0] as { custom_id: string; min_values?: number; max_values?: number; options: Array<{ value: string; default?: boolean }> };
  assert.equal(component.custom_id, 'two:self-role:games');
  assert.equal(component.min_values, 0);
  assert.equal(component.max_values, 2);
  assert.deepEqual(component.options.map((o) => [o.value, !!o.default]), [['one', false], ['two', true]]);
});

test('exclusive color selects cap the member at one role', () => {
  const exclusive = { ...panel, id: 'colors', exclusive: true, color: true };
  const json = buildSelfRoleComponents(exclusive)[0].toJSON();
  const component = json.components[0] as { max_values?: number; placeholder?: string };
  assert.equal(component.max_values, 1);
  assert.equal(component.placeholder, 'Choose your color');
});

test('button panels chunk at five controls per row and show held roles', () => {
  const buttons: SelfRolePanel = {
    ...panel,
    mode: 'button',
    options: Array.from({ length: 6 }, (_, i) => ({
      key: `r${i}`,
      label: `Role ${i}`,
      roleId: `${i + 1}`.padStart(18, '1'),
      permissions: '0',
    })),
  };
  const rows = buildSelfRoleComponents(buttons, [buttons.options[0].roleId]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].components.length, 5);
  assert.equal(rows[1].components.length, 1);
  assert.equal((rows[0].components[0].toJSON() as { style: number }).style, 3);
});

test('reaction panels have no message components', () => {
  assert.deepEqual(buildSelfRoleComponents({ ...panel, mode: 'reaction' }), []);
});

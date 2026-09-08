import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketTestHelpers, ticketChannelName, buildTicketPanel, buildTicketControls } from '../src/discord/tickets.ts';

test('ticket controls have stable custom ids', () => {
  const panel = buildTicketPanel();
  const controls = buildTicketControls();
  const panelJson = panel.toJSON() as unknown as { components: Array<{ custom_id?: string }> };
  const controlsJson = controls.toJSON() as unknown as { components: Array<{ custom_id?: string }> };
  assert.equal(panelJson.components[0]?.custom_id, 'two:tickets:open');
  assert.deepEqual(
    controlsJson.components.map((button) => button.custom_id),
    ['two:tickets:claim', 'two:tickets:close'],
  );
});

test('ticket channel names are safe and bounded', () => {
  const name = ticketChannelName({ user: { username: 'A very unsafe Username!!!' } } as never);
  assert.match(name, /^ticket-[a-z0-9-]+$/);
  assert.ok(name.length <= 31);
});

test('ticket cooldown refuses only recent tickets', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');
  assert.equal(ticketTestHelpers.withinCooldown('2026-09-08T11:59:00.000Z', now, 300), true);
  assert.equal(ticketTestHelpers.withinCooldown('2026-09-08T11:50:00.000Z', now, 300), false);
  assert.equal(ticketTestHelpers.withinCooldown(null, now, 300), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events, MessageFlags, type Client, type Interaction } from 'discord.js';
import { loadTempVoiceConfig } from '../src/tempVoice/config.ts';
import { registerTempVoice } from '../src/tempVoice/discord.ts';
import type { ControlContext, ControlOutcome, TempVoiceService } from '../src/tempVoice/service.ts';

const GUILD = 'guild';
const ACTOR = 'actor';
const VOICE_CHANNEL = 'actor-voice-channel';
const PANEL_CHANNEL = 'panel-text-channel';
type Surface = 'slash' | 'select';
type Action = 'permit' | 'reject';
type Target = { id: string; type: 'member' | 'role' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// The registered callback returns void. Drain its bounded promise chain without
// a gateway, timer, or polling for an external event.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function fixture(surface: Surface, action: Action, target: Target) {
  const calls: Array<{ action: Action; ctx: ControlContext; target: Target }> = [];
  const trace: string[] = [];
  const responses: Array<{ method: 'reply' | 'editReply'; payload: unknown }> = [];
  const deferPayloads: unknown[] = [];
  const deferral = deferred<void>();
  const outcome = deferred<ControlOutcome>();
  const voiceStates = new Map([
    [ACTOR, { channelId: VOICE_CHANNEL }],
    [target.id, { channelId: 'target-voice-channel' }],
  ]);
  const resolvedTarget = target.type === 'role'
    ? { id: target.id, name: 'Selected role' }
    : { id: target.id, user: { id: target.id, username: 'Selected member' } };
  const interaction = {
    guildId: GUILD,
    guild: { voiceStates: { cache: voiceStates } },
    channelId: PANEL_CHANNEL,
    user: { id: ACTOR },
    commandName: 'voice',
    customId: `tempvoice:select:${action}`,
    values: [target.id, 'unselected-target'],
    // A member selection can coexist with an unrelated role in the collection;
    // classification must test membership of the selected ID, not role count.
    roles: new Map<string, { id: string }>([
      ['unselected-role', { id: 'unselected-role' }],
      ...(target.type === 'role' ? [[target.id, resolvedTarget] as const] : []),
    ]),
    options: {
      getSubcommand: (required: boolean) => {
        assert.equal(required, true);
        return action;
      },
      getMentionable: (name: string, required: boolean) => {
        assert.equal(name, 'target');
        assert.equal(required, true);
        return resolvedTarget;
      },
      getRole: (name: string) => {
        assert.equal(name, 'target');
        return target.type === 'role' ? resolvedTarget : null;
      },
    },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => surface === 'slash',
    isButton: () => false,
    isModalSubmit: () => false,
    isAnySelectMenu: () => surface === 'select',
    isMentionableSelectMenu: () => surface === 'select',
    isRepliable: () => true,
    async deferReply(payload: unknown) {
      deferPayloads.push(payload);
      trace.push('defer:start');
      await deferral.promise;
      interaction.deferred = true;
      trace.push('defer:done');
    },
    async reply(payload: unknown) {
      interaction.replied = true;
      responses.push({ method: 'reply', payload });
      trace.push('reply');
    },
    async editReply(payload: unknown) {
      responses.push({ method: 'editReply', payload });
      trace.push('editReply');
    },
  };
  const service = Object.fromEntries((['permit', 'reject'] as const).map((method) => [
    method,
    async (ctx: ControlContext, translated: Target): Promise<ControlOutcome> => {
      calls.push({ action: method, ctx, target: translated });
      trace.push(`service:${method}`);
      return outcome.promise;
    },
  ]));
  const listeners = new Map<string, (interaction: Interaction) => void>();
  const client = {
    on(event: string, listener: (interaction: Interaction) => void) {
      assert.equal(listeners.has(event), false, `duplicate registration for ${event}`);
      listeners.set(event, listener);
    },
  };
  registerTempVoice(client as unknown as Client, {
    guildId: GUILD,
    service: service as unknown as TempVoiceService,
    config: { ...loadTempVoiceConfig({}), enabled: true },
  });
  const handler = listeners.get(Events.InteractionCreate);
  assert.ok(handler, 'registerTempVoice must install the interaction handler');
  return {
    interaction, voiceStates, calls, trace, responses, deferPayloads, deferral, outcome,
    dispatch: () => handler(interaction as unknown as Interaction),
  };
}

async function assertTranslation(
  surface: Surface,
  action: Action,
  target: Target,
  connected: boolean = true,
): Promise<void> {
  const f = fixture(surface, action, target);
  if (!connected) f.voiceStates.delete(ACTOR);
  f.dispatch();
  await flushMicrotasks();
  assert.deepEqual(f.trace, ['defer:start']);
  assert.deepEqual(f.deferPayloads, [{ flags: MessageFlags.Ephemeral }]);
  assert.deepEqual(f.calls, [], 'service must wait for the acknowledgement to resolve');
  assert.deepEqual(f.responses, []);

  f.deferral.resolve();
  await flushMicrotasks();
  assert.deepEqual(f.trace, ['defer:start', 'defer:done', `service:${action}`]);
  assert.deepEqual(f.calls, [{
    action,
    ctx: { guildId: GUILD, actorId: ACTOR, actorChannelId: connected ? VOICE_CHANNEL : null },
    target,
  }]);
  assert.deepEqual(f.responses, [], 'final response must wait for the service outcome');

  const message = `${surface} ${action} ${target.type} complete`;
  f.outcome.resolve({ status: 'ok', message });
  await flushMicrotasks();
  assert.deepEqual(f.trace, ['defer:start', 'defer:done', `service:${action}`, 'editReply']);
  assert.deepEqual(f.responses, [{ method: 'editReply', payload: { content: message } }]);
  assert.equal(f.calls.length, 1);
}

for (const surface of ['slash', 'select'] as const) {
  for (const action of ['permit', 'reject'] as const) {
    for (const type of ['member', 'role'] as const) {
      test(`registered voice ${surface} ${action} preserves ${type} target and cached actor channel`, async () => {
        await assertTranslation(surface, action, { id: `selected-${type}`, type });
      });
    }
  }

  test(`registered voice ${surface} preserves a disconnected actor as null`, async () => {
    await assertTranslation(surface, 'reject', { id: 'selected-member', type: 'member' }, false);
  });

  for (const ignored of ['other guild', 'outside guild', 'unrelated interaction'] as const) {
    test(`registered voice ${surface} ignores ${ignored}`, async () => {
      const f = fixture(surface, 'permit', { id: 'selected-role', type: 'role' });
      if (ignored === 'other guild') f.interaction.guildId = 'other-guild';
      if (ignored === 'outside guild') f.interaction.inGuild = () => false;
      if (ignored === 'unrelated interaction') {
        f.interaction.commandName = 'unrelated';
        f.interaction.customId = 'unrelated:select:permit';
      }
      f.deferral.resolve();
      f.outcome.resolve({ status: 'ok', message: 'must not be used' });
      f.dispatch();
      await flushMicrotasks();
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.deferPayloads, []);
      assert.deepEqual(f.responses, []);
      assert.deepEqual(f.trace, []);
    });
  }
}

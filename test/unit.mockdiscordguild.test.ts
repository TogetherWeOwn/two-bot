import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { GUILD_ID } from '../src/onboarding/catalog.ts';

test('mock guild override is instance-local and consistent across REST and gateway payloads', { timeout: 10_000 }, async (t) => {
  const original = await startMockDiscord();
  t.after(() => original.close());
  const synthetic = await startMockDiscord({ guildId: '900000000000007000' });
  t.after(() => synthetic.close());
  assert.equal(original.guildId, GUILD_ID);
  assert.notEqual(synthetic.guildId, original.guildId);
  await Promise.all([original, synthetic].map(async (mock) => {
    const frames: { t: string; d: any }[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${mock.port}/gw`);
    t.after(() => socket.terminate());
    const guild = await new Promise<any>((res, rej) => {
      socket.on('error', rej);
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.op === 10) socket.send(JSON.stringify({ op: 2, d: {} }));
        if (frame.op === 0) frames.push(frame);
        if (frame.t === 'GUILD_CREATE') res(frame.d);
      });
    });
    assert.equal(guild.id, mock.guildId);
    assert.equal(guild.roles.find((role: { name: string }) => role.name === '@everyone').id, mock.guildId);
    for (const channel of guild.channels) {
      assert.equal(channel.guild_id, mock.guildId);
      for (const overwrite of channel.permission_overwrites) {
        if (overwrite.deny !== '0') assert.equal(overwrite.id, mock.guildId);
      }
    }
    assert.equal(frames.find((frame) => frame.t === 'READY')!.d.guilds[0].id, mock.guildId);
    const member = '900000000000007010';
    mock.memberJoinPending(member, 'synthetic');
    mock.memberAcceptRules(member, 'synthetic');
    mock.message(member);
    mock.voiceJoin(member);
    mock.selectGames(member, 'synthetic', []);
    mock.selectSession(member, 'synthetic', []);
    mock.memberRemove(member, 'synthetic');
    await new Promise<void>((res) => {
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).t === 'GUILD_MEMBER_REMOVE') res();
      });
    });
    for (const frame of frames.filter((f) => f.d.guild_id)) assert.equal(frame.d.guild_id, mock.guildId);
    assert.equal(frames.filter((f) => f.d.guild_id).length, 7);
    const invites = await fetch(`${mock.apiBase}/v10/guilds/${mock.guildId}/invites`).then((r) => r.json()) as { guild: { id: string } }[];
    assert.equal(invites[0].guild.id, mock.guildId);
    const posted = await fetch(`${mock.apiBase}/v10/channels/${mock.textChannelId}/messages`, {
      method: 'POST', body: JSON.stringify({ content: 'synthetic' }),
    }).then((r) => r.json()) as { guild_id: string };
    assert.equal(posted.guild_id, mock.guildId);
  }));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonInteraction } from 'discord.js';
import { ticketTestHelpers, type TicketDeps, type TicketRecord, type TicketStore } from '../src/discord/tickets.ts';

function fixture(failure?: 'create' | 'record' | 'activate' | 'send' | 'ack', deleteFails = false) {
  const error = new Error(`${failure} failed`);
  const calls: string[] = [];
  let record: TicketRecord | null = null;
  let channelExists = false;
  const channel = {
    id: 'channel',
    async send() {
      calls.push('send');
      if (failure === 'send') throw error;
    },
    async delete(reason: string) {
      assert.equal(reason, 'ticket open failed');
      calls.push('delete');
      if (deleteFails) throw new Error('delete failed');
      channelExists = false;
    },
    permissionOverwrites: {
      async edit() { calls.push('deny'); },
    },
  };
  const interaction = {
    guild: {
      id: 'guild',
      members: { me: { id: 'bot' } },
      channels: {
        async create() {
          calls.push('create');
          if (failure === 'create') throw error;
          channelExists = true;
          return channel;
        },
      },
    },
    member: { id: 'member', user: { username: 'Member' } },
    async deferReply() { calls.push('defer'); },
    async editReply(reply: { content: string }) {
      assert.equal(reply.content, 'Your private ticket is ready: <#channel>');
      calls.push('ack');
      if (failure === 'ack') throw error;
    },
  } as unknown as ButtonInteraction;
  const store = {
    async activeFor() { return record; },
    async lastCreatedAt() { return null; },
    async reserve(guildId: string, openerId: string, createdAt: string) {
      calls.push('reserve');
      record = { id: 'ticket', guildId, openerId, createdAt, channelId: null, claimedBy: null, status: 'creating', closingStartedAt: null, closedAt: null };
      return record;
    },
    async recordCreatedChannel(id: string, channelId: string) {
      assert.equal(id, record?.id);
      calls.push('record');
      if (failure === 'record') throw error;
      record = { ...record!, channelId };
      return record;
    },
    async activate(id: string, channelId: string) {
      assert.equal(id, record?.id);
      calls.push('activate');
      if (failure === 'activate') throw error;
      record = { ...record!, channelId, status: 'open' };
      return record;
    },
    async abandon(id: string) {
      assert.equal(id, record?.id);
      calls.push('abandon');
      record = null;
    },
    async markCleanupPending(id: string, closedAt: string, channelId: string) {
      assert.equal(id, record?.id);
      calls.push('cleanup');
      record = { ...record!, channelId, status: 'cleanup_pending', closedAt };
    },
  } as unknown as TicketStore;
  const deps = { db: {} as never, categoryId: 'category', staffRoleId: 'staff', panelChannelId: 'panel' } satisfies TicketDeps;
  return {
    error,
    calls,
    open: () => ticketTestHelpers.openTicket(interaction, deps, store),
    record: () => record,
    channelExists: () => channelExists,
  };
}

const opened = ['defer', 'reserve', 'create', 'record', 'activate', 'send', 'ack'];

test('ticket acknowledgement failure preserves the opened channel and record without compensation', async () => {
  const f = fixture('ack');
  await assert.rejects(f.open(), f.error);
  assert.deepEqual(f.calls, opened);
  assert.equal(f.channelExists(), true);
  assert.equal(f.record()?.status, 'open');
  assert.equal(f.record()?.channelId, 'channel');
});

test('successful ticket open acknowledges the ready channel', async () => {
  const f = fixture();
  await f.open();
  assert.deepEqual(f.calls, opened);
  assert.equal(f.channelExists(), true);
  assert.equal(f.record()?.status, 'open');
});

for (const failure of ['create', 'record', 'activate', 'send'] as const) {
  test(`ticket ${failure} failure still compensates before acknowledgement`, async () => {
    const f = fixture(failure);
    await assert.rejects(f.open(), f.error);
    const steps = opened.slice(0, opened.indexOf(failure) + 1);
    assert.deepEqual(f.calls, [...steps, ...(failure === 'create' ? [] : ['delete']), 'abandon']);
    assert.equal(f.channelExists(), false);
    assert.equal(f.record(), null);
  });
}

test('failed ticket rollback retains a cleanup-pending record instead of abandoning it', async () => {
  const f = fixture('send', true);
  await assert.rejects(f.open(), f.error);
  assert.deepEqual(f.calls, [...opened.slice(0, -1), 'delete', 'deny', 'cleanup']);
  assert.equal(f.channelExists(), true);
  assert.equal(f.record()?.status, 'cleanup_pending');
  assert.equal(f.record()?.channelId, 'channel');
});

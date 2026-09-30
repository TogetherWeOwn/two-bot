import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonInteraction, Client } from 'discord.js';
import { openEphemeralTestDb as openDb } from './helpers/testDb.ts';
import { TicketStore, ticketTestHelpers, type TicketDeps, type TicketTranscript } from '../src/discord/tickets.ts';

async function fixture(t: TestContext, failure?: 'lock' | 'fetch' | 'save' | 'cleanup' | 'ack' | 'delete') {
  const db = await openDb();
  t.after(() => db.close());
  const store = new TicketStore(db);
  const reserved = (await store.reserve('guild', 'member', '2026-09-08T12:00:00.000Z'))!;
  await store.activate(reserved.id, 'channel');
  await store.claim('channel', 'staff');
  const error = new Error(`${failure} failed`);
  const permissions: Array<{ userId: string; values: Record<string, boolean> }> = [];
  const deletions: string[] = [];
  const replies: string[] = [];
  let writable = true;
  let channelExists = true;
  const channel = {
    id: 'channel',
    isTextBased: () => true,
    isDMBased: () => false,
    permissionOverwrites: {
      async edit(userId: string, values: Record<string, boolean>) {
        permissions.push({ userId, values });
        if (failure === 'lock' && values.SendMessages === false) throw error;
        writable = values.SendMessages;
      },
    },
    messages: {
      async fetch() {
        assert.equal(writable, false);
        if (failure === 'fetch') throw error;
        return new Map([['message', {
          createdTimestamp: Date.parse('2026-09-08T12:00:10.000Z'),
          author: { tag: 'Member' },
          content: 'final ticket message',
          attachments: new Map(),
        }]]);
      },
    },
    async delete(reason: string) {
      deletions.push(reason);
      if (failure === 'delete' && reason === 'ticket closed') throw error;
      channelExists = false;
    },
  };
  const interaction = {
    guild: { id: 'guild' },
    channelId: 'channel',
    channel,
    member: { roles: { cache: new Map([['staff', {}]]) } },
    async deferReply() {},
    async editReply(reply: { content: string }) {
      replies.push(reply.content);
      if (failure === 'ack') {
        assert.equal((await store.byChannel('channel'))?.status, 'cleanup_pending');
        assert.equal(await store.transcriptExists(reserved.id), true);
        throw error;
      }
    },
  } as unknown as ButtonInteraction;
  const client = { channels: { async fetch(channelId: string) {
    assert.equal(channelId, 'channel');
    return channelExists ? channel : null;
  } } } as unknown as Client;
  if (failure === 'save') t.mock.method(store, 'saveTranscript', async () => { throw error; });
  if (failure === 'cleanup') t.mock.method(store, 'markCleanupPending', async () => { throw error; });
  const deps = { db, categoryId: 'category', staffRoleId: 'staff', panelChannelId: 'panel' } satisfies TicketDeps;
  return {
    store, client, error, permissions, deletions, replies,
    close: () => ticketTestHelpers.closeTicket(interaction, deps, store),
    record: () => store.byChannel('channel'),
    transcript: () => db.prepare('SELECT * FROM ticket_transcripts WHERE ticket_id = ?').get<Record<string, unknown>>(reserved.id),
    writable: () => writable,
    channelExists: () => channelExists,
  };
}

const locked = [{ userId: 'member', values: { SendMessages: false } }];
const restored = { userId: 'member', values: { ViewChannel: true, SendMessages: true, ReadMessageHistory: true } };

function assertTranscript(transcript: Record<string, unknown> | undefined) {
  assert.ok(transcript);
  assert.equal(transcript.guild_id, 'guild');
  assert.equal(transcript.channel_id, 'channel');
  assert.equal(transcript.opener_id, 'member');
  assert.equal(transcript.claimed_by, 'staff');
  assert.equal(transcript.message_count, 1);
  assert.equal(transcript.content, '[2026-09-08T12:00:10.000Z] Member: final ticket message');
  assert.equal(ticketTestHelpers.purgeAfter(transcript.created_at as string), transcript.purge_after);
}

test('close acknowledgement failure never restores writing after transcript commitment; cleanup retries preserve provenance', async (t) => {
  const f = await fixture(t, 'ack');
  await assert.rejects(f.close(), f.error);
  assert.deepEqual(f.permissions, locked);
  assert.equal(f.writable(), false);
  assert.equal(f.channelExists(), true);
  assert.deepEqual(f.deletions, []);
  const pending = await f.record();
  assert.equal(pending?.status, 'cleanup_pending');
  assert.ok(pending?.closingStartedAt);
  assert.ok(pending?.closedAt);
  const transcript = await f.transcript();
  assertTranscript(transcript);

  await ticketTestHelpers.retryCleanup(f.client, f.store, 'guild');
  assert.equal(f.channelExists(), false);
  assert.deepEqual(f.deletions, ['retry ticket cleanup']);
  assert.deepEqual(f.permissions, locked);
  assert.deepEqual(await f.record(), { ...pending, status: 'closed' });
  assert.deepEqual(await f.transcript(), transcript);
  await ticketTestHelpers.retryCleanup(f.client, f.store, 'guild');
  assert.deepEqual(f.deletions, ['retry ticket cleanup']);
});

test('failure transitioning a committed transcript to cleanup remains recoverable without reopening', async (t) => {
  const f = await fixture(t, 'cleanup');
  await assert.rejects(f.close(), f.error);
  assert.deepEqual(f.permissions, locked);
  assert.equal(f.writable(), false);
  const closing = await f.record();
  assert.equal(closing?.status, 'closing');
  const transcript = await f.transcript();
  assertTranscript(transcript);
  assert.equal(await ticketTestHelpers.recoverClosing(f.client, f.store, '9999-01-01T00:00:00.000Z', 'guild'), 1);
  assert.equal((await f.record())?.status, 'cleanup_pending');
  await ticketTestHelpers.retryCleanup(f.client, f.store, 'guild');
  assert.equal((await f.record())?.status, 'closed');
  assert.equal((await f.record())?.closingStartedAt, closing?.closingStartedAt);
  assert.deepEqual(f.permissions, locked);
  assert.deepEqual(await f.transcript(), transcript);
});

for (const failure of ['lock', 'fetch', 'save'] as const) {
  test(`pre-transcript ${failure} failure still restores opener permissions and reopens the ticket`, async (t) => {
    const f = await fixture(t, failure);
    await assert.rejects(f.close(), f.error);
    assert.deepEqual(f.permissions, [...locked, restored]);
    assert.equal(f.writable(), true);
    assert.equal((await f.record())?.status, 'open');
    assert.equal((await f.record())?.closingStartedAt, null);
    assert.equal(await f.transcript(), undefined);
    assert.deepEqual(f.deletions, []);
  });
}

test('acknowledgement failure after losing close ownership cannot restore writing or replace the final transcript', async (t) => {
  const f = await fixture(t, 'ack');
  const save = f.store.saveTranscript.bind(f.store);
  t.mock.method(f.store, 'saveTranscript', async (transcript: TicketTranscript, startedAt?: string | null) => {
    assert.equal(await save(transcript, startedAt), true);
    await f.store.markCleanupPending(transcript.ticketId, transcript.createdAt);
    return false;
  });
  t.mock.method(f.store, 'reopenAfterCloseFailure', async () => { assert.fail('must not reopen'); });
  await assert.rejects(f.close(), f.error);
  assert.deepEqual(f.replies, ['This ticket close was already recovered or completed.']);
  assert.deepEqual(f.permissions, locked);
  assert.equal(f.writable(), false);
  assertTranscript(await f.transcript());
});

test('channel deletion failure keeps the committed transcript recoverable and read-only', async (t) => {
  const f = await fixture(t, 'delete');
  await f.close();
  assert.equal((await f.record())?.status, 'cleanup_pending');
  const transcript = await f.transcript();
  assertTranscript(transcript);
  await ticketTestHelpers.retryCleanup(f.client, f.store, 'guild');
  assert.equal((await f.record())?.status, 'closed');
  assert.deepEqual(f.permissions, locked);
  assert.deepEqual(await f.transcript(), transcript);
});

test('successful close deletes the channel and retains the final transcript without restoring writing', async (t) => {
  const f = await fixture(t);
  await f.close();
  assert.equal((await f.record())?.status, 'closed');
  assert.equal(f.channelExists(), false);
  assert.deepEqual(f.deletions, ['ticket closed']);
  assert.deepEqual(f.permissions, locked);
  assertTranscript(await f.transcript());
});

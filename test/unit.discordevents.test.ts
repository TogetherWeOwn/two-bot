import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { moderationAuditEvent, rawMessageAuditEvent } from '../src/audit/discordEvents.ts';

// TOG-9559: hermetic shaping + PII coverage for src/audit/discordEvents.ts.
// No Discord client, no DB: moderationAuditEvent takes plain entry objects
// (cast with `as never`, same as unit.audit.test.ts) and rawMessageAuditEvent
// takes raw dispatch packets.

const GUILD = '1545644954272137297';
const MEMBER = '900000000000000001';
const MODERATOR = '900000000000000002';
const CHANNEL = '900000000000000101';
const MESSAGE = '900000000000000201';
const CREATED = 1_700_000_000_000;
const OBSERVED = '2026-09-09T00:00:00.000Z';

// Every entry of the MODERATION_ACTIONS map in discordEvents.ts.
const ACTION_TABLE: Array<[AuditLogEvent, string]> = [
  [AuditLogEvent.MemberKick, 'member_kick'],
  [AuditLogEvent.MemberPrune, 'member_prune'],
  [AuditLogEvent.MemberBanAdd, 'member_ban'],
  [AuditLogEvent.MemberBanRemove, 'member_unban'],
  [AuditLogEvent.MemberUpdate, 'member_update'],
  [AuditLogEvent.MemberRoleUpdate, 'member_role_update'],
  [AuditLogEvent.MemberMove, 'member_move'],
  [AuditLogEvent.MemberDisconnect, 'member_disconnect'],
  [AuditLogEvent.MessageDelete, 'message_delete'],
  [AuditLogEvent.MessageBulkDelete, 'message_bulk_delete'],
  [AuditLogEvent.ChannelUpdate, 'channel_update'],
  [AuditLogEvent.ChannelOverwriteCreate, 'channel_overwrite_create'],
  [AuditLogEvent.ChannelOverwriteUpdate, 'channel_overwrite_update'],
  [AuditLogEvent.ChannelOverwriteDelete, 'channel_overwrite_delete'],
];

function moderationEntry(
  action: AuditLogEvent,
  id: string,
  extra: unknown,
  reason: string,
): never {
  return {
    id,
    action,
    createdTimestamp: CREATED,
    executorId: MODERATOR,
    targetId: MEMBER,
    reason,
    extra,
  } as never;
}

for (const [action, slug] of ACTION_TABLE) {
  test(`moderation shaping: ${slug} carries action, channel and count`, () => {
    // MemberPrune and bulk deletes report `removed` instead of `count` in
    // real Discord payloads; everything else reports `count`.
    const extra =
      slug === 'member_prune' || slug === 'message_bulk_delete'
        ? { channel: { id: CHANNEL }, removed: 7 }
        : { channel: { id: CHANNEL }, count: 3 };
    const expectedCount = slug === 'member_prune' || slug === 'message_bulk_delete' ? 7 : 3;
    const event = moderationAuditEvent(
      moderationEntry(action, `audit-${slug}`, extra, `free-text reason for ${slug}`),
      GUILD,
    );

    assert.ok(event);
    assert.equal(event.kind, 'moderation_action');
    assert.equal(event.channel, 'moderation');
    assert.equal(event.action, slug);
    assert.equal(event.guildId, GUILD);
    assert.equal(event.entryId, `discord-audit:${GUILD}:audit-${slug}`);
    assert.equal(event.actorId, MODERATOR);
    assert.equal(event.targetId, MEMBER);
    assert.equal(event.sourceChannelId, CHANNEL);
    assert.deepEqual(event.metadata, { auditLogEntryId: `audit-${slug}`, count: expectedCount });
  });
}

test('moderation shaping: missing channel/count extras yield nulls, not crashes', () => {
  const noExtra = moderationAuditEvent(
    moderationEntry(AuditLogEvent.MemberKick, 'audit-no-extra', null, 'reason'),
    GUILD,
  );
  assert.ok(noExtra);
  assert.equal(noExtra.sourceChannelId, null);
  assert.deepEqual(noExtra.metadata, { auditLogEntryId: 'audit-no-extra', count: null });

  const emptyExtra = moderationAuditEvent(
    moderationEntry(AuditLogEvent.MessageDelete, 'audit-empty-extra', {}, 'reason'),
    GUILD,
  );
  assert.ok(emptyExtra);
  assert.equal(emptyExtra.sourceChannelId, null);
  assert.deepEqual(emptyExtra.metadata, { auditLogEntryId: 'audit-empty-extra', count: null });
});

test('moderation shaping: unknown audit-log actions return null', () => {
  for (const action of [AuditLogEvent.BotAdd, AuditLogEvent.MessagePin, AuditLogEvent.RoleCreate]) {
    assert.equal(
      moderationAuditEvent(moderationEntry(action, 'audit-unknown', null, 'reason'), GUILD),
      null,
    );
  }
});

test('raw shaping: MESSAGE_DELETE carries channel and message ids', () => {
  assert.deepEqual(
    rawMessageAuditEvent(
      { op: 0, t: 'MESSAGE_DELETE', s: 1, d: { guild_id: GUILD, channel_id: CHANNEL, id: MESSAGE } },
      0,
      OBSERVED,
    ),
    {
      entryId: `message-delete:${GUILD}:${MESSAGE}`,
      kind: 'message_delete',
      channel: 'audit',
      guildId: GUILD,
      occurredAt: OBSERVED,
      actorId: null,
      targetId: null,
      sourceChannelId: CHANNEL,
      messageId: MESSAGE,
    },
  );
});

test('raw shaping: MESSAGE_UPDATE minimal edit uses the shard/sequence identity', () => {
  const event = rawMessageAuditEvent(
    { op: 0, t: 'MESSAGE_UPDATE', s: 13, d: { guild_id: GUILD, channel_id: CHANNEL, id: MESSAGE } },
    2,
    OBSERVED,
  );
  assert.ok(event);
  assert.equal(event.kind, 'message_edit');
  assert.equal(event.entryId, `message-edit:${GUILD}:${MESSAGE}:shard-2:sequence-13`);
  assert.equal(event.occurredAt, OBSERVED);
  assert.equal(event.actorId, null);
  assert.equal(event.targetId, null);
  assert.equal(event.sourceChannelId, CHANNEL);
  assert.equal(event.messageId, MESSAGE);
});

test('raw shaping: MESSAGE_UPDATE with edited_timestamp rekeys on the edit time', () => {
  const event = rawMessageAuditEvent(
    {
      op: 0, t: 'MESSAGE_UPDATE', s: 14,
      d: { guild_id: GUILD, channel_id: CHANNEL, id: MESSAGE, edited_timestamp: '2026-09-09T00:00:02.000Z' },
    },
    2,
    OBSERVED,
  );
  assert.ok(event);
  assert.equal(event.entryId, `message-edit:${GUILD}:${MESSAGE}:2026-09-09T00:00:02.000Z`);
  assert.equal(event.occurredAt, '2026-09-09T00:00:02.000Z');
});

test('raw shaping: MESSAGE_UPDATE attributes the author id without PII fields', () => {
  const event = rawMessageAuditEvent(
    {
      op: 0, t: 'MESSAGE_UPDATE', s: 15,
      d: {
        guild_id: GUILD, channel_id: CHANNEL, id: MESSAGE,
        edited_timestamp: '2026-09-09T00:00:02.000Z',
        author: { id: MEMBER, username: 'SneakyUsername', global_name: 'Sneaky Global' },
      },
    },
    2,
  );
  assert.ok(event);
  assert.equal(event.actorId, MEMBER);
  assert.equal(event.targetId, MEMBER);
  assert.doesNotMatch(JSON.stringify(event), /SneakyUsername|Sneaky Global/);
});

test('raw shaping: malformed dispatches return null', () => {
  const valid = { guild_id: GUILD, channel_id: CHANNEL, id: MESSAGE };
  assert.equal(rawMessageAuditEvent({ op: 1, t: 'MESSAGE_DELETE', s: 1, d: valid }, 0), null);
  assert.equal(rawMessageAuditEvent({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: valid }, 0), null);
  assert.equal(rawMessageAuditEvent({ op: 0, t: 'GUILD_CREATE', s: 1, d: valid }, 0), null);
  assert.equal(rawMessageAuditEvent({ op: 0, s: 1, d: valid }, 0), null);
  assert.equal(rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: null }, 0), null);
  assert.equal(rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: 'nope' }, 0), null);
  assert.equal(rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: [valid] }, 0), null);
  assert.equal(
    rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: { channel_id: CHANNEL, id: MESSAGE } }, 0),
    null,
  );
  assert.equal(
    rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: { guild_id: GUILD, id: MESSAGE } }, 0),
    null,
  );
  assert.equal(
    rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: { guild_id: GUILD, channel_id: CHANNEL } }, 0),
    null,
  );
  assert.equal(
    rawMessageAuditEvent({ op: 0, t: 'MESSAGE_DELETE', s: 1, d: { guild_id: '', channel_id: CHANNEL, id: MESSAGE } }, 0),
    null,
  );
  assert.equal(
    rawMessageAuditEvent({ op: 0, t: 'MESSAGE_UPDATE', s: 1, d: { guild_id: GUILD, channel_id: CHANNEL } }, 0),
    null,
  );
});

test('shaped discord events never carry free-text reasons, content, or usernames', () => {
  // Sentinels must not appear in ANY serialized shaped event below.
  const REASON = 'FreeTextReason-NickFrost-quota-appeal';
  const CONTENT = 'TopSecretMessageContent-plans-inside';
  const USERNAME = 'SneakyUsername-pii-probe';
  const NICKNAME = 'SneakyNick-pii-probe';

  const shaped: unknown[] = [];
  for (const [action, slug] of ACTION_TABLE) {
    const event = moderationAuditEvent(
      moderationEntry(
        action,
        `audit-pii-${slug}`,
        { channel: { id: CHANNEL }, count: 3 },
        `${REASON} by ${USERNAME} aka ${NICKNAME}`,
      ),
      GUILD,
    );
    assert.ok(event);
    shaped.push(event);
  }
  shaped.push(
    rawMessageAuditEvent(
      {
        op: 0, t: 'MESSAGE_DELETE', s: 21,
        d: { id: 'pii-delete', guild_id: GUILD, channel_id: CHANNEL, content: CONTENT },
      },
      0,
      OBSERVED,
    ),
    rawMessageAuditEvent(
      {
        op: 0, t: 'MESSAGE_UPDATE', s: 22,
        d: {
          id: 'pii-edit', guild_id: GUILD, channel_id: CHANNEL,
          content: CONTENT,
          author: { id: MEMBER, username: USERNAME, global_name: NICKNAME },
          edited_timestamp: '2026-09-09T00:00:02.000Z',
        },
      },
      0,
      OBSERVED,
    ),
  );

  // The scrubbed set per TOG-8300: user/inviter/target_user/bot/creator reduce
  // to { id }; discordEvents output carries only ids, timestamps, action
  // names, counts and auditLogEntryId. None of the free text may survive.
  const serialized = JSON.stringify(shaped);
  assert.doesNotMatch(serialized, new RegExp(REASON));
  assert.doesNotMatch(serialized, new RegExp(CONTENT));
  assert.doesNotMatch(serialized, new RegExp(USERNAME));
  assert.doesNotMatch(serialized, new RegExp(NICKNAME));
  assert.match(serialized, new RegExp(MEMBER));
  assert.match(serialized, new RegExp(CHANNEL));
});

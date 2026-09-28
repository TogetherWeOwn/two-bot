/**
 * PRIVACY.md retention compliance (TOG-5718).
 *
 * Pins the retention/deletion claims in docs/PRIVACY.md against the store
 * code, so a doc edit or a store change that breaks the promise reds here:
 *
 *  - ticket transcripts live exactly 90 days past close (`purge_after`), and
 *    the startup purge deletes only rows whose `purge_after` has passed;
 *  - member erasure removes the member's rows from the ticket tables and the
 *    operational audit log (including rows whose opaque `entry_id` embeds the
 *    member ID for event identity), while leaving other members' rows alone;
 *  - the deletion SQL in the doc is complete: every per-member identity
 *    column the schema holds is covered by one of the doc's DELETEs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openEphemeralTestDb as openDb } from './helpers/testDb.ts';
import { TicketStore, ticketTestHelpers } from '../src/discord/tickets.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';

const GUILD = '111111111111111111';
const MEMBER = '900000000000000001';
const OTHER = '900000000000000002';

describe('PRIVACY.md retention compliance', () => {
  test('transcript purge_after is createdAt plus exactly 90 days', () => {
    // docs/PRIVACY.md: "Private ticket transcripts are retained for
    // **90 days after close**."
    assert.equal(
      ticketTestHelpers.purgeAfter('2026-09-08T12:00:00.000Z'),
      '2026-12-07T12:00:00.000Z',
    );
  });

  test('startup purge deletes only rows whose purge_after has passed', async () => {
    // docs/PRIVACY.md: "Startup deletes rows whose `purge_after` has passed."
    const db = await openDb();
    try {
      const store = new TicketStore(db);
      const reserved = (await store.reserve(GUILD, MEMBER, '2026-09-08T12:00:00.000Z'))!;
      await store.activate(reserved.id, 'channel-a');
      const closing = await store.beginClose('channel-a', '2026-09-08T12:00:30.000Z');
      assert.ok(closing);
      const saved = await store.saveTranscript({
        ticketId: reserved.id,
        guildId: GUILD,
        channelId: 'channel-a',
        openerId: MEMBER,
        claimedBy: null,
        content: 'expired transcript',
        messageCount: 1,
        createdAt: '2026-09-08T12:01:00.000Z',
        purgeAfter: '2026-09-09T12:01:00.000Z',
      }, closing.closingStartedAt);
      assert.equal(saved, true);

      // A second ticket whose transcript is still inside its 90 days.
      const reserved2 = (await store.reserve(GUILD, OTHER, '2026-09-08T12:00:00.000Z'))!;
      await store.activate(reserved2.id, 'channel-b');
      const closing2 = await store.beginClose('channel-b', '2026-09-08T12:00:30.000Z');
      assert.ok(closing2);
      const saved2 = await store.saveTranscript({
        ticketId: reserved2.id,
        guildId: GUILD,
        channelId: 'channel-b',
        openerId: OTHER,
        claimedBy: null,
        content: 'live transcript',
        messageCount: 1,
        createdAt: '2026-09-08T12:02:00.000Z',
        purgeAfter: '2026-12-07T12:02:00.000Z',
      }, closing2.closingStartedAt);
      assert.equal(saved2, true);

      assert.equal(await store.purgeExpired('2026-09-09T12:01:00.000Z'), 1);
      assert.equal(await store.transcriptExists(reserved.id), false);
      assert.equal(await store.transcriptExists(reserved2.id), true);
    } finally {
      await db.close();
    }
  });

  test('ticket erasure removes the opener and the claimer, nobody else', async () => {
    // docs/PRIVACY.md deletion SQL: opener_id OR claimed_by on both tables.
    const db = await openDb();
    try {
      const store = new TicketStore(db);
      const mine = (await store.reserve(GUILD, MEMBER, '2026-09-08T12:00:00.000Z'))!;
      await store.activate(mine.id, 'channel-a');
      const closing = await store.beginClose('channel-a', '2026-09-08T12:00:30.000Z');
      assert.ok(closing);
      await store.saveTranscript({
        ticketId: mine.id,
        guildId: GUILD,
        channelId: 'channel-a',
        openerId: MEMBER,
        claimedBy: OTHER,
        content: 'claimed by other',
        messageCount: 1,
        createdAt: '2026-09-08T12:01:00.000Z',
        purgeAfter: '2026-12-07T12:01:00.000Z',
      }, closing.closingStartedAt);

      const theirs = (await store.reserve(GUILD, OTHER, '2026-09-08T12:05:00.000Z'))!;
      await store.activate(theirs.id, 'channel-b');

      await store.eraseMember(MEMBER);
      // Mine is gone from both tables even though OTHER claimed it; the
      // claimer's own ticket survives.
      assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get<{ n: number }>())?.n, 1);
      assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ticket_transcripts`).get<{ n: number }>())?.n, 0);
      assert.equal((await store.byChannel('channel-b'))?.openerId, OTHER);
    } finally {
      await db.close();
    }
  });

  test('operational-audit erasure removes actor/target rows, keeps the rest', async () => {
    // docs/PRIVACY.md: "its opaque `entry_id` may still contain a member ID
    // for event identity, so matching rows are deleted rather than
    // anonymized."
    const db = await openDb();
    try {
      const store = new OperationalAuditStore(db);
      const at = '2026-09-09T00:00:00.000Z';
      await store.record({
        entryId: `member-update:${GUILD}:${MEMBER}:${at}:digest`,
        kind: 'member_update', channel: 'audit', guildId: GUILD,
        occurredAt: at, targetId: MEMBER,
      });
      await store.record({
        entryId: `voice_join:${GUILD}:${MEMBER}:none:chan:${at}`,
        kind: 'voice_join', channel: 'voice', guildId: GUILD,
        occurredAt: at, targetId: MEMBER,
        sourceChannelId: null, destinationChannelId: 'chan',
      });
      await store.record({
        entryId: 'unrelated', kind: 'message_delete', channel: 'audit', guildId: GUILD,
        occurredAt: at, actorId: OTHER,
      });

      assert.equal(await store.eraseMember(MEMBER), 2);
      assert.equal(await store.get(`member-update:${GUILD}:${MEMBER}:${at}:digest`), null);
      assert.equal(await store.get(`voice_join:${GUILD}:${MEMBER}:none:chan:${at}`), null);
      assert.ok(await store.get('unrelated'));
    } finally {
      await db.close();
    }
  });

  test('doc deletion SQL covers every per-member identity column in the schema', async () => {
    // docs/PRIVACY.md lists one DELETE per per-member table. If the schema
    // gains a member-id column this test does not know about, the query
    // below fails and the doc must grow a line.
    //
    // Deliberately out of scope here, with reasons:
    // - `presence_probe` holds one guild-wide number per hour with no
    //   per-member data (see docs/PRESENCE_PROBE.md).
    // - `created_by`/`updated_by` columns (automation_commands,
    //   scheduled_messages, sticky_messages, feed_relays, lfg_posts,
    //   temp_voice_channels) and `guild_settings(_audit).updated_by`/`actor`
    //   are staff-admin attribution, not member data; a member erasure only
    //   touches them when the requester was the admin author, case by case.
    // - `audit target_key` columns (automation/announcements audit logs) are
    //   free-form keys, not provably member IDs.
    // - `self_role_audit.source_id` is the reaction/message/component source.
    // - `events.metadata.inviterId` survives inside *other members'* join
    //   rows: it is someone else's join record, and deleting it would corrupt
    //   another member's funnel history. The doc says so explicitly.
    const db = await openDb();
    try {
      const rows = await db.prepare(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND column_name IN
              ('member_id', 'user_id', 'actor_id', 'target_id',
               'opener_id', 'claimed_by', 'inviter_id', 'executor_id',
               'owner_id', 'generator_id', 'pending_owner_id')
          ORDER BY table_name, column_name`,
      ).all<{ table_name: string; column_name: string }>();
      const covered: Record<string, string[]> = {
        ticket_transcripts: ['opener_id', 'claimed_by'],
        tickets: ['opener_id', 'claimed_by'],
        xp_awards: ['member_id'],
        xp_cooldowns: ['member_id'],
        member_levels: ['member_id'],
        events: ['member_id'],
        members: ['member_id'],
        member_ranks: ['member_id'],
        member_exclusions: ['member_id'],
        invite_snapshots: ['inviter_id'],
        community_facts: ['actor_id'],
        automod_violations: ['user_id'],
        automod_processed_messages: ['user_id'],
        moderation_warnings: ['user_id', 'actor_id'],
        moderation_scheduled_unbans: ['user_id'],
        moderation_audit: ['target_id', 'actor_id'],
        operational_audit_log: ['target_id', 'actor_id'],
        containment_events: ['target_id', 'executor_id'],
        containment_incidents: ['executor_id'],
        join_risk_flags: ['member_id'],
        event_rsvps: ['user_id'],
        lfg_signups: ['user_id'],
        self_role_audit: ['member_id'],
        self_role_panel_claims: ['member_id'],
        temp_voice_creates: ['user_id'],
        temp_voice_audit: ['actor_id'],
        temp_voice_channels: ['owner_id', 'generator_id', 'pending_owner_id'],
        announcements_audit_log: ['actor_id'],
        automation_audit_log: ['actor_id'],
      };
      const uncovered = rows.filter(
        (r) => !(covered[r.table_name] ?? []).includes(r.column_name),
      );
      assert.deepEqual(
        uncovered,
        [],
        `docs/PRIVACY.md deletion SQL does not cover: ${JSON.stringify(uncovered)}. ` +
          `Add the DELETE line to the doc (or scope the column out here with a reason).`,
      );
    } finally {
      await db.close();
    }
  });
});

/**
 * Temporary voice channels: join-to-create, owner controls, and cleanup
 * (TOG-3052, implementing §4 of the TOG-3044 research).
 *
 * Everything Discord-shaped goes through `TempVoiceGateway` so the rules below
 * are testable without a gateway connection. The rules are the point; the
 * discord.js adapter is the boring part.
 *
 * THE HARD INVARIANT: a channel with no persisted row is never deleted. Not by
 * the sweep, not by the boot reconcile, not by an owner control. Inferring
 * ownership from category membership is the documented anti-pattern from the
 * research (`by-nari`) and in this guild it would delete `Lobby`. Every
 * deletion path in this file funnels through `deleteGeneratedChannel`, which
 * looks the row up itself rather than trusting its caller.
 */
import { log } from '../core/log.ts';
import type { AutomodPolicy } from '../automod/types.ts';
import { filterChannelName, renderNameTemplate } from './nameFilter.ts';
import { RenameThrottle } from './rename.ts';
import type { TempVoiceConfig, TempVoiceControl } from './config.ts';
import type { TempVoiceRow, TempVoiceStore } from './store.ts';

/** Discord: "Maximum number of channels in category reached (50)". */
export const CATEGORY_FULL_CODE = 50035;
/** Discord: Unknown Channel. A 404 on delete is success, not an error. */
export const UNKNOWN_CHANNEL_CODE = 10003;
/** Discord: Missing Permissions. Always a server-setup fault, never transient. */
export const MISSING_PERMISSIONS_CODE = 50013;

export type OverwriteFlag = 'ViewChannel' | 'Connect' | 'Speak' | 'ManageChannels' | 'MoveMembers' | 'ManageRoles';

/**
 * Every permission `overwritesFor` hands out, which is the same thing as every
 * permission the bot must itself hold.
 *
 * Discord refuses with 50013 when a bot creates an overwrite granting a
 * permission it does not hold, so a single missing flag here turns every join
 * of the generator into a failed create. A test asserts this list is exactly
 * the union of the flags `overwritesFor` allows, so the two cannot drift.
 */
export const TEMP_VOICE_REQUIRED_PERMISSIONS: readonly OverwriteFlag[] = [
  'ViewChannel',
  'Connect',
  'Speak',
  'ManageChannels',
  'MoveMembers',
  'ManageRoles',
];

/**
 * A PARTIAL overwrite edit: flags named in `allow`/`deny` are set, every other
 * flag on the target's existing overwrite is left exactly as it was.
 */
export interface OverwriteSpec {
  id: string;
  type: 'member' | 'role';
  allow?: OverwriteFlag[];
  deny?: OverwriteFlag[];
}

export class TempVoiceGatewayError extends Error {
  code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = 'TempVoiceGatewayError';
    this.code = code;
  }
}

export interface TempVoiceGateway {
  createVoiceChannel(input: {
    guildId: string;
    name: string;
    categoryId: string;
    /** Sort position; the service asks for "just below the generator". */
    position?: number;
    overwrites: OverwriteSpec[];
  }): Promise<{ id: string }>;
  /** Resolves 'missing' for an already-deleted channel - a 404 is success. */
  deleteChannel(channelId: string, reason: string): Promise<'deleted' | 'missing'>;
  moveMember(guildId: string, userId: string, channelId: string | null): Promise<void>;
  renameChannel(channelId: string, name: string): Promise<void>;
  setUserLimit(channelId: string, limit: number): Promise<void>;
  setBitrate(channelId: string, bitrate: number): Promise<void>;
  applyOverwrite(channelId: string, overwrite: OverwriteSpec): Promise<void>;
  clearOverwrite(channelId: string, targetId: string): Promise<void>;
  /** Connected member ids, or null when the channel no longer exists. */
  occupantsOf(channelId: string): Promise<string[] | null>;
  /** The sort position a new channel should take to land below `channelId`. */
  positionBelow(channelId: string): Promise<number | undefined>;
  /** False when the target outranks the bot, so `kick` refuses instead of 403ing. */
  canMove(guildId: string, userId: string): Promise<boolean>;
  /** The guild's bitrate ceiling, which depends on its boost tier. */
  maxBitrate(guildId: string): Promise<number>;
  /** Which of `flags` the bot does NOT hold inside `categoryId`. */
  missingPermissions(guildId: string, categoryId: string, flags: readonly OverwriteFlag[]): Promise<OverwriteFlag[]>;
  botUserId(): string;
}

export interface TempVoiceDeps {
  store: TempVoiceStore;
  gateway: TempVoiceGateway;
  config: TempVoiceConfig;
  policy: AutomodPolicy;
  now?: () => number;
  throttle?: RenameThrottle;
}

export type CreateOutcome =
  | { status: 'created'; channelId: string; name: string }
  | { status: 'refused'; reason: string }
  | { status: 'skipped' };

export interface ControlContext {
  guildId: string;
  actorId: string;
  /** The voice channel the actor is connected to right now, if any. */
  actorChannelId: string | null;
}

export type ControlOutcome =
  | { status: 'ok'; message: string }
  | { status: 'refused'; message: string }
  | { status: 'noop'; message: string };

export interface ReconcileReport {
  adopted: number;
  deleted: number;
  rowsDropped: number;
  reservationsDropped: number;
}

const MIN_BITRATE = 8000;

/**
 * Module-level so a test can assert its granted flags are exactly
 * TEMP_VOICE_REQUIRED_PERMISSIONS without reaching into a private method.
 */
export function tempVoiceOverwrites(guildId: string, botId: string, ownerId: string): OverwriteSpec[] {
  return [
    // Public by default. `lock` denies Connect for @everyone; `hide` denies
    // ViewChannel. Both are per-channel edits of this same overwrite.
    { id: guildId, type: 'role', allow: ['ViewChannel', 'Connect', 'Speak'] },
    // Only the bot needs ManageRoles to edit channel overwrites for controls.
    { id: botId, type: 'member', allow: ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers', 'ManageRoles'] },
    { id: ownerId, type: 'member', allow: ['ViewChannel', 'Connect', 'Speak', 'ManageChannels', 'MoveMembers'] },
  ];
}

export class TempVoiceService {
  private store: TempVoiceStore;
  private gateway: TempVoiceGateway;
  private config: TempVoiceConfig;
  private policy: AutomodPolicy;
  private now: () => number;
  private throttle: RenameThrottle;

  constructor(deps: TempVoiceDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.config = deps.config;
    this.policy = deps.policy;
    this.now = deps.now ?? Date.now;
    this.throttle = deps.throttle ?? new RenameThrottle();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ---------------------------------------------------------------- deletion

  /**
   * The ONLY way this feature deletes a voice channel.
   *
   * Two independent guards, in this order:
   *   1. `protectedChannelIds` - `Lobby`, the generator and the category are
   *      excluded by id and can never be argued into deletion.
   *   2. A persisted row. No row means Owen did not create it, which means it
   *      is not ours to delete, no matter what the caller believes.
   *
   * Relaxing either one is the failure this feature is most likely to have, so
   * both are covered by dedicated tests in test/unit.tempvoice.test.ts, and
   * `node scripts/mutate-tempvoice.ts` proves those tests actually fail when
   * the guards are relaxed rather than merely exercising the happy path.
   */
  async deleteGeneratedChannel(
    guildId: string,
    channelId: string,
    reason: string,
  ): Promise<'deleted' | 'missing' | 'refused'> {
    if (this.config.protectedChannelIds.has(channelId)) {
      log.error('temp_voice_delete_refused', { guildId, channelId, reason: 'protected_channel' });
      await this.store.audit(
        { guildId, actorId: null, channelId, action: 'delete', outcome: 'refused', reason: 'protected_channel' },
        this.iso(),
      );
      return 'refused';
    }
    const row = await this.store.getByChannel(guildId, channelId);
    if (!row) {
      log.error('temp_voice_delete_refused', { guildId, channelId, reason: 'no_persisted_row' });
      await this.store.audit(
        { guildId, actorId: null, channelId, action: 'delete', outcome: 'refused', reason: 'no_persisted_row' },
        this.iso(),
      );
      return 'refused';
    }

    // Idempotent by construction: 'missing' is the gateway telling us Discord
    // already has no such channel, which is exactly the state we wanted.
    const outcome = await this.gateway.deleteChannel(channelId, reason);
    await this.store.deleteById(row.id);
    this.throttle.forget(channelId);
    await this.store.audit(
      { guildId, actorId: null, channelId, action: 'delete', outcome, reason },
      this.iso(),
    );
    log.info('temp_voice_deleted', { guildId, channelId, outcome, reason });
    return outcome;
  }

  // ------------------------------------------------------------------ create

  /** A member joined the generator. Create their channel and move them in. */
  async onGeneratorJoin(input: { guildId: string; userId: string; username: string }): Promise<CreateOutcome> {
    if (!this.config.enabled) return { status: 'skipped' };

    // Boot logging alone cannot stop a broken generator. Recheck effective
    // category permissions before reserving a slot or making any mutation.
    const { missing } = await this.preflight(input.guildId);
    if (missing.length) {
      return {
        status: 'refused',
        reason: `Ask a server admin to grant these permissions to the bot on the voice category: ${missing.join(', ')}.`,
      };
    }

    const createdAt = this.iso();
    const mine = await this.store.countForOwner(input.guildId, input.userId);
    const total = await this.store.countForGuild(input.guildId);
    // The rename control filters through automod, so creation must too: a
    // display name carrying a blocked word or invite link must not become a
    // channel name. Fall back to the username-less template rather than
    // refusing the join. Only a template that is itself blocked refuses, and
    // that is an operator misconfiguration to fix, not a member to punish.
    // The generator is the filter context: it is the channel the member is
    // sitting in, and there is no generated channel yet to name.
    const where = { guildId: input.guildId, channelId: this.config.generatorChannelId, userId: input.userId };
    const rendered = renderNameTemplate(this.config.nameTemplate, {
      username: input.username,
      count: mine + 1,
      seq: total + 1,
    });
    const filtered = filterChannelName(rendered, this.policy, where);
    let name: string;
    if (filtered.ok) {
      name = filtered.name;
    } else {
      const bare = renderNameTemplate(this.config.nameTemplate, {
        username: '',
        count: mine + 1,
        seq: total + 1,
      });
      const fallback = filterChannelName(bare, this.policy, where);
      if (!fallback.ok) {
        // The guild's own template violates its own automod policy. Creating
        // anyway would mint a forbidden name, so refuse loudly instead of
        // laundering it through.
        log.error('temp_voice_create_name_blocked', { guildId: input.guildId, reason: fallback.reason });
        await this.store.audit(
          { guildId: input.guildId, actorId: input.userId, channelId: null, action: 'create', outcome: 'refused', reason: 'name_blocked' },
          createdAt,
        );
        return { status: 'refused', reason: `That channel name is not allowed here. ${fallback.reason}` };
      }
      log.info('temp_voice_create_name_filtered', { guildId: input.guildId, userId: input.userId });
      name = fallback.name;
    }

    // The claim enforces every cap atomically and writes the row, all before a
    // single Discord mutation. Anti-abuse that runs after the create is not
    // anti-abuse, it is cleanup.
    const claim = await this.store.reserveIfUnderCaps({
      guildId: input.guildId,
      generatorId: this.config.generatorChannelId,
      categoryId: this.config.categoryId,
      ownerId: input.userId,
      name,
      createdAt,
      maxPerUser: this.config.maxPerUser,
      maxPerGuild: this.config.maxPerGuild,
      cooldownSeconds: this.config.createCooldownSeconds,
    });
    if (!claim.ok) {
      const message = {
        user_cap: `You already have ${this.config.maxPerUser === 1 ? 'a' : String(this.config.maxPerUser)} temporary voice channel${this.config.maxPerUser === 1 ? '' : 's'}.`,
        guild_cap: 'This server has reached its temporary voice channel limit. Try again shortly.',
        cooldown: `Please wait ${this.config.createCooldownSeconds} seconds between creating channels.`,
      }[claim.reason];
      await this.store.audit(
        { guildId: input.guildId, actorId: input.userId, channelId: null, action: 'create', outcome: 'refused', reason: claim.reason },
        createdAt,
      );
      log.info('temp_voice_create_refused', { guildId: input.guildId, userId: input.userId, reason: claim.reason });
      // Nothing was created, so the member is left sitting in the generator.
      // Moving them out would be a worse surprise than a one-line refusal.
      return { status: 'refused', reason: message };
    }

    const row = claim.row;
    let channelId: string | null = null;
    try {
      const position = await this.gateway.positionBelow(this.config.generatorChannelId);
      const created = await this.gateway.createVoiceChannel({
        guildId: input.guildId,
        name,
        categoryId: this.config.categoryId,
        position,
        overwrites: this.overwritesFor(input.guildId, input.userId),
      });
      channelId = created.id;
      if (!(await this.store.attach(row.id, channelId))) {
        throw new Error(`temp-voice reservation ${row.id} disappeared before the channel was recorded`);
      }
      // Deliberately NOT seeding the rename throttle here. Creating a channel
      // is not a rename, and a fresh channel whose owner cannot name it for
      // five minutes is the feature failing at the only moment they care.
      await this.gateway.moveMember(input.guildId, input.userId, channelId);
      await this.store.audit(
        { guildId: input.guildId, actorId: input.userId, channelId, action: 'create', outcome: 'created' },
        this.iso(),
      );
      log.info('temp_voice_created', { guildId: input.guildId, userId: input.userId, channelId, name });
      return { status: 'created', channelId, name };
    } catch (err) {
      // A failed create can release its reservation immediately only if no
      // channel was created. Otherwise keep provenance (and the cap slot)
      // until Discord confirms deletion or a 404. A failed cleanup is retried
      // by the ordinary sweep/boot reconcile, not converted into an orphan.
      let cleanupPending = false;
      if (channelId) {
        // Retry attachment if the original write failed transiently. If even
        // this cannot persist the known id, fail loudly rather than discarding
        // the reservation or reporting a recoverable cleanup without evidence.
        if (!(await this.store.attach(row.id, channelId))) {
          throw new Error(`temp-voice rollback cannot persist channel ${channelId} for reservation ${row.id}`, { cause: err });
        }
        try {
          const deleted = await this.deleteGeneratedChannel(input.guildId, channelId, 'temp-voice create rollback');
          if (deleted === 'refused') throw new Error('temp-voice rollback deletion refused');
        } catch (cleanupError) {
          cleanupPending = true;
          log.error('temp_voice_create_rollback_failed', {
            guildId: input.guildId, channelId, reservationId: row.id, err: String(cleanupError),
          });
          await this.store.audit(
            { guildId: input.guildId, actorId: input.userId, channelId, action: 'create_rollback', outcome: 'failed', reason: String(cleanupError).slice(0, 300) },
            this.iso(),
          );
        }
      } else {
        // No channel was created, so the reservation row AND the
        // reservation-time cooldown stamp go back together: a failed join
        // must not burn the creator's cooldown (TOG-9561).
        await this.store.rollbackReservation({
          reservationId: row.id,
          guildId: input.guildId,
          userId: input.userId,
          stampedAt: createdAt,
        });
      }

      const code = err instanceof TempVoiceGatewayError ? err.code : null;
      if (code === CATEGORY_FULL_CODE) {
        await this.store.audit(
          { guildId: input.guildId, actorId: input.userId, channelId: null, action: 'create', outcome: 'refused', reason: 'category_full' },
          this.iso(),
        );
        log.error('temp_voice_category_full', { guildId: input.guildId, categoryId: this.config.categoryId });
        return {
          status: 'refused',
          reason: 'The voice category is full (Discord allows 50 channels per category). Ask a moderator to make room.',
        };
      }
      if (code === MISSING_PERMISSIONS_CODE) {
        // Retrying cannot fix this, so the message must not ask for a retry.
        // The overwrite names permissions the bot has to hold itself, and the
        // usual cause is exactly one of them missing on the category.
        await this.store.audit(
          { guildId: input.guildId, actorId: input.userId, channelId: null, action: 'create', outcome: 'refused', reason: 'missing_permissions' },
          this.iso(),
        );
        log.error('temp_voice_missing_permissions', {
          guildId: input.guildId,
          categoryId: this.config.categoryId,
          required: TEMP_VOICE_REQUIRED_PERMISSIONS,
          err: String(err),
        });
        return {
          status: 'refused',
          reason:
            'I am not allowed to create a channel here, so retrying will not help. ' +
            `Ask a server admin to give me these permissions on the voice category: ${TEMP_VOICE_REQUIRED_PERMISSIONS.join(', ')}.`,
        };
      }
      await this.store.audit(
        { guildId: input.guildId, actorId: input.userId, channelId: null, action: 'create', outcome: 'failed', reason: String(err).slice(0, 300) },
        this.iso(),
      );
      log.error('temp_voice_create_failed', { guildId: input.guildId, userId: input.userId, err: String(err) });
      return {
        status: 'refused',
        reason: cleanupPending
          ? 'Could not finish creating your voice channel. Cleanup is pending; your channel limit remains reserved until it is removed.'
          : 'Could not create your voice channel. Please try again.',
      };
    }
  }

  /**
   * Boot-time permission check.
   *
   * Without it the first symptom of a missing grant is a member joining the
   * generator, waiting, and getting a DM - and the operator finding out from
   * them. This says which permission is missing, by name, at startup, while
   * still letting the process run: the rest of the bot is unaffected and a
   * refusal to boot would be a worse failure than a loud log line.
   */
  async preflight(guildId: string): Promise<{ ok: boolean; missing: OverwriteFlag[] }> {
    if (!this.config.enabled) return { ok: true, missing: [] };
    const missing = await this.gateway.missingPermissions(
      guildId,
      this.config.categoryId,
      TEMP_VOICE_REQUIRED_PERMISSIONS,
    );
    if (missing.length) {
      log.error('temp_voice_preflight_failed', {
        guildId,
        categoryId: this.config.categoryId,
        missing,
        hint: 'grant these to the bot on the category, not guild-wide',
      });
    } else {
      log.info('temp_voice_preflight_ok', { guildId, categoryId: this.config.categoryId });
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Explicit overwrites, never category inheritance.
   *
   * The owner gets ManageChannels + MoveMembers ON THIS CHANNEL ONLY. Owen
   * holds no guild-wide Administrator and must not need any: granting the
   * feature by making the bot an administrator is the specific thing TempVoice
   * does that the research says to refuse.
   */
  private overwritesFor(guildId: string, ownerId: string): OverwriteSpec[] {
    return tempVoiceOverwrites(guildId, this.gateway.botUserId(), ownerId);
  }

  // ------------------------------------------------------------ voice states

  /**
   * One member's voice state changed. Marks our channels empty or occupied;
   * the actual delete is the sweep's job, after the grace window.
   */
  async onVoiceStateChange(input: {
    guildId: string;
    userId: string;
    fromChannelId: string | null;
    toChannelId: string | null;
  }): Promise<CreateOutcome> {
    if (!this.config.enabled) return { status: 'skipped' };

    if (input.fromChannelId && input.fromChannelId !== input.toChannelId) {
      await this.markOccupancy(input.guildId, input.fromChannelId);
    }
    if (input.toChannelId && input.toChannelId !== input.fromChannelId) {
      await this.markOccupancy(input.guildId, input.toChannelId);
    }
    return { status: 'skipped' };
  }

  /** Record whether one of our channels is currently empty. Never deletes. */
  private async markOccupancy(guildId: string, channelId: string): Promise<void> {
    const row = await this.store.getByChannel(guildId, channelId);
    if (!row) return;
    const occupants = await this.gateway.occupantsOf(channelId);
    if (occupants === null) {
      // Gone from Discord entirely - drop the row, delete nothing.
      await this.store.deleteById(row.id);
      this.throttle.forget(channelId);
      return;
    }
    const emptySince = occupants.length === 0 ? this.iso() : null;
    if ((row.emptySince === null) !== (emptySince === null)) {
      await this.store.setEmptySince(row.id, emptySince);
    }
  }

  // ------------------------------------------------------- reconcile & sweep

  /**
   * Boot reconcile (Robotnic's cleanup trilogy). For every persisted child:
   * gone from Discord -> drop the row; present and empty -> delete the channel;
   * present and occupied -> re-adopt it, so a restart with somebody sitting in
   * a generated channel does not strand them or ghost the row.
   */
  async reconcile(guildId: string): Promise<ReconcileReport> {
    const report: ReconcileReport = { adopted: 0, deleted: 0, rowsDropped: 0, reservationsDropped: 0 };
    if (!this.config.enabled) return report;

    for (const row of await this.store.listLive(guildId)) {
      const channelId = row.channelId!;
      const occupants = await this.gateway.occupantsOf(channelId);
      if (occupants === null) {
        await this.store.deleteById(row.id);
        this.throttle.forget(channelId);
        report.rowsDropped++;
        continue;
      }
      if (occupants.length === 0) {
        // Boot-time empties are deleted immediately: the grace window exists to
        // absorb a member reconnecting, and anyone who was going to reconnect
        // did so while we were down.
        if ((await this.deleteGeneratedChannel(guildId, channelId, 'temp-voice boot reconcile: empty')) !== 'refused') {
          report.deleted++;
        }
        continue;
      }
      if (row.pendingOwnerId !== null && !(await this.recoverOwnerChange(guildId, channelId))) continue;
      await this.store.setEmptySince(row.id, null);
      // Only a real rename starts a window. Seeding from `createdAt` would
      // make a restart silently cost the owner their first rename. The queued
      // name is reseeded too (TOG-9560): without it a restart drops the rename
      // the service already promised would land, and the sweep never flushes.
      if (row.lastRenamedAt) this.throttle.seed(channelId, Date.parse(row.lastRenamedAt), row.pendingChannelName);
      report.adopted++;
    }

    // A reservation that never got a channel id is dropped, never used to
    // justify a delete. If the create did land before we died, its channel is
    // now an orphan we deliberately LEAK rather than guess at - this log line
    // is the handle for cleaning it up by hand.
    const cutoff = new Date(this.now() - 5 * 60 * 1000).toISOString();
    for (const row of await this.store.listStaleReservations(guildId, cutoff)) {
      await this.store.deleteById(row.id);
      report.reservationsDropped++;
      log.error('temp_voice_reservation_orphaned', {
        guildId,
        reservationId: row.id,
        ownerId: row.ownerId,
        name: row.name,
        hint: 'a channel may exist with no row; it is deliberately NOT auto-deleted',
      });
    }
    return report;
  }

  /**
   * Periodic sweep for what the gateway missed, and the place empty channels
   * actually die.
   *
   * The empty marker is re-checked here rather than trusted: discord.js' member
   * cache lags, so "empty" at the moment of the leave event can be wrong. A
   * channel is deleted only if it is still empty when its grace has expired.
   */
  async sweep(guildId: string): Promise<ReconcileReport> {
    const report: ReconcileReport = { adopted: 0, deleted: 0, rowsDropped: 0, reservationsDropped: 0 };
    if (!this.config.enabled) return report;
    const graceMs = this.config.emptyGraceSeconds * 1000;

    for (const row of await this.store.listLive(guildId)) {
      const channelId = row.channelId!;
      const occupants = await this.gateway.occupantsOf(channelId);
      if (occupants === null) {
        await this.store.deleteById(row.id);
        this.throttle.forget(channelId);
        report.rowsDropped++;
        continue;
      }
      if (occupants.length > 0) {
        if (row.pendingOwnerId !== null && !(await this.recoverOwnerChange(guildId, channelId))) continue;
        if (row.emptySince !== null) await this.store.setEmptySince(row.id, null);
        await this.flushPendingRename(row, channelId);
        continue;
      }
      if (row.emptySince === null) {
        await this.store.setEmptySince(row.id, this.iso());
        continue;
      }
      if (this.now() - Date.parse(row.emptySince) < graceMs) continue;
      if ((await this.deleteGeneratedChannel(guildId, channelId, 'temp-voice sweep: empty past grace')) !== 'refused') {
        report.deleted++;
      }
    }
    return report;
  }

  /**
   * Apply a rename that was throttled earlier, once its window has opened.
   *
   * The journaled name is the fallback source: reconcile normally reseeds the
   * throttle from it at boot, but a sweep that runs without a reconcile (or
   * with a reconcile that predates the queue) must still honor the promise.
   * The throttle still decides readiness, so the window is never skipped.
   */
  private async flushPendingRename(row: TempVoiceRow, channelId: string): Promise<void> {
    let pending = this.throttle.pending(channelId, row.name);
    if (!pending && row.pendingChannelName) {
      if (row.pendingChannelName === row.name) {
        // Landed out of band (renamed directly on Discord): nothing is owed,
        // so retire the journal instead of carrying it forever.
        await this.store.setPendingName(row.id, null);
        return;
      }
      this.throttle.seed(channelId, row.lastRenamedAt ? Date.parse(row.lastRenamedAt) : 0, row.pendingChannelName);
      pending = this.throttle.pending(channelId, row.name);
    }
    if (!pending || !this.throttle.ready(channelId, this.now())) return;
    try {
      await this.gateway.renameChannel(channelId, pending);
      const at = this.iso();
      this.throttle.applied(channelId, pending, this.now());
      await this.store.setName(row.id, pending, at);
      log.info('temp_voice_rename_flushed', { channelId, name: pending });
    } catch (err) {
      log.error('temp_voice_rename_flush_failed', { channelId, err: String(err) });
    }
  }

  // ---------------------------------------------------------------- controls

  private disabled(control: TempVoiceControl): boolean {
    return this.config.disabledControls.has(control);
  }

  /**
   * Resolve the channel a control applies to, applying the three standing
   * rules: no-op outside a bot-created channel, refused for a non-owner, and
   * scoped to the channel the actor is actually connected to.
   */
  private async resolve(
    control: TempVoiceControl,
    ctx: ControlContext,
    options: { requireOwner?: boolean } = {},
  ): Promise<{ ok: true; row: TempVoiceRow; channelId: string } | { ok: false; outcome: ControlOutcome }> {
    if (!this.config.enabled) {
      return { ok: false, outcome: { status: 'noop', message: 'Temporary voice channels are not enabled here.' } };
    }
    if (this.disabled(control)) {
      return { ok: false, outcome: { status: 'refused', message: `The \`${control}\` control is disabled on this server.` } };
    }
    if (!ctx.actorChannelId) {
      return { ok: false, outcome: { status: 'noop', message: 'Join your temporary voice channel first.' } };
    }
    const row = await this.store.getByChannel(ctx.guildId, ctx.actorChannelId);
    if (!row) {
      return { ok: false, outcome: { status: 'noop', message: 'This is not a temporary voice channel.' } };
    }
    if (row.pendingOwnerId !== null) {
      return { ok: false, outcome: { status: 'refused', message: 'An ownership change is pending recovery. Controls are unavailable until it completes.' } };
    }
    if ((options.requireOwner ?? true) && row.ownerId !== ctx.actorId) {
      return { ok: false, outcome: { status: 'refused', message: `Only <@${row.ownerId}> can do that here.` } };
    }
    return { ok: true, row, channelId: ctx.actorChannelId };
  }

  private async record(ctx: ControlContext, channelId: string | null, action: string, outcome: ControlOutcome): Promise<ControlOutcome> {
    await this.store.audit(
      {
        guildId: ctx.guildId,
        actorId: ctx.actorId,
        channelId,
        action,
        outcome: outcome.status,
        reason: outcome.status === 'ok' ? undefined : outcome.message.slice(0, 300),
      },
      this.iso(),
    );
    return outcome;
  }

  /**
   * Rename. The caller MUST have deferred its reply already: a throttled rename
   * returns without touching Discord, but an un-throttled one is a real API
   * call that discord.js may sit on.
   */
  async rename(ctx: ControlContext, requested: string): Promise<ControlOutcome> {
    const resolved = await this.resolve('name', ctx);
    if (!resolved.ok) return resolved.outcome;
    const { row, channelId } = resolved;

    const filtered = filterChannelName(requested, this.policy, {
      guildId: ctx.guildId,
      channelId,
      userId: ctx.actorId,
    });
    if (!filtered.ok) return this.record(ctx, channelId, 'name', { status: 'refused', message: filtered.reason });

    const decision = this.throttle.request(channelId, filtered.name, this.now());
    if (!decision.apply) {
      // Journal the promise BEFORE replying "queued": the name must survive a
      // restart (TOG-9560). The journal write and the memory write carry the
      // same name, so a crash between them can only leave a name the sweep
      // would converge to anyway once the window opens.
      await this.store.setPendingName(row.id, filtered.name);
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      return this.record(ctx, channelId, 'name', {
        status: 'ok',
        message: `Discord only allows a couple of renames per channel per 10 minutes, so **${filtered.name}** is queued and lands in about ${seconds}s.`,
      });
    }
    await this.gateway.renameChannel(channelId, filtered.name);
    await this.store.setName(row.id, filtered.name, this.iso());
    return this.record(ctx, channelId, 'name', { status: 'ok', message: `Renamed to **${filtered.name}**.` });
  }

  async setLimit(ctx: ControlContext, limit: number): Promise<ControlOutcome> {
    const resolved = await this.resolve('limit', ctx);
    if (!resolved.ok) return resolved.outcome;
    if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
      return this.record(ctx, resolved.channelId, 'limit', { status: 'refused', message: 'The user limit must be between 0 (unlimited) and 99.' });
    }
    await this.gateway.setUserLimit(resolved.channelId, limit);
    return this.record(ctx, resolved.channelId, 'limit', {
      status: 'ok',
      message: limit === 0 ? 'User limit removed.' : `User limit set to ${limit}.`,
    });
  }

  async setBitrate(ctx: ControlContext, bitrate: number): Promise<ControlOutcome> {
    const resolved = await this.resolve('bitrate', ctx);
    if (!resolved.ok) return resolved.outcome;
    const max = await this.gateway.maxBitrate(ctx.guildId);
    if (!Number.isInteger(bitrate) || bitrate < MIN_BITRATE || bitrate > max) {
      return this.record(ctx, resolved.channelId, 'bitrate', {
        status: 'refused',
        message: `Bitrate must be between ${MIN_BITRATE} and ${max} bps on this server.`,
      });
    }
    await this.gateway.setBitrate(resolved.channelId, bitrate);
    return this.record(ctx, resolved.channelId, 'bitrate', { status: 'ok', message: `Bitrate set to ${bitrate} bps.` });
  }

  async lock(ctx: ControlContext, locked: boolean): Promise<ControlOutcome> {
    const control: TempVoiceControl = locked ? 'lock' : 'unlock';
    const resolved = await this.resolve(control, ctx);
    if (!resolved.ok) return resolved.outcome;
    // Only `Connect` is touched. `lock` and `hide` edit the same @everyone
    // overwrite, so a whole-overwrite rewrite would silently un-hide a hidden
    // channel the moment its owner unlocked it.
    await this.gateway.applyOverwrite(resolved.channelId, {
      id: ctx.guildId,
      type: 'role',
      allow: locked ? [] : ['Connect'],
      deny: locked ? ['Connect'] : [],
    });
    return this.record(ctx, resolved.channelId, control, {
      status: 'ok',
      message: locked ? 'Channel locked. Only permitted members can join.' : 'Channel unlocked.',
    });
  }

  async hide(ctx: ControlContext, hidden: boolean): Promise<ControlOutcome> {
    const control: TempVoiceControl = hidden ? 'hide' : 'reveal';
    const resolved = await this.resolve(control, ctx);
    if (!resolved.ok) return resolved.outcome;
    await this.gateway.applyOverwrite(resolved.channelId, {
      id: ctx.guildId,
      type: 'role',
      allow: hidden ? [] : ['ViewChannel'],
      deny: hidden ? ['ViewChannel'] : [],
    });
    return this.record(ctx, resolved.channelId, control, {
      status: 'ok',
      message: hidden ? 'Channel hidden from everyone else.' : 'Channel visible again.',
    });
  }

  async permit(ctx: ControlContext, target: { id: string; type: 'member' | 'role' }): Promise<ControlOutcome> {
    const resolved = await this.resolve('permit', ctx);
    if (!resolved.ok) return resolved.outcome;
    await this.gateway.applyOverwrite(resolved.channelId, {
      id: target.id,
      type: target.type,
      allow: ['ViewChannel', 'Connect', 'Speak'],
    });
    return this.record(ctx, resolved.channelId, 'permit', {
      status: 'ok',
      message: `Permitted ${target.type === 'role' ? `<@&${target.id}>` : `<@${target.id}>`}.`,
    });
  }

  async reject(ctx: ControlContext, target: { id: string; type: 'member' | 'role' }): Promise<ControlOutcome> {
    const resolved = await this.resolve('reject', ctx);
    if (!resolved.ok) return resolved.outcome;
    const { row, channelId } = resolved;
    if (target.id === row.ownerId) {
      return this.record(ctx, channelId, 'reject', { status: 'refused', message: 'You cannot reject the channel owner.' });
    }
    await this.gateway.applyOverwrite(channelId, { id: target.id, type: target.type, deny: ['Connect'] });
    // Anyone already inside is removed, or "reject" is advice rather than a rule.
    if (target.type === 'member') {
      const occupants = (await this.gateway.occupantsOf(channelId)) ?? [];
      if (occupants.includes(target.id) && (await this.gateway.canMove(ctx.guildId, target.id))) {
        await this.gateway.moveMember(ctx.guildId, target.id, null);
      }
    }
    return this.record(ctx, channelId, 'reject', {
      status: 'ok',
      message: `Rejected ${target.type === 'role' ? `<@&${target.id}>` : `<@${target.id}>`}.`,
    });
  }

  async kick(ctx: ControlContext, targetId: string): Promise<ControlOutcome> {
    const resolved = await this.resolve('kick', ctx);
    if (!resolved.ok) return resolved.outcome;
    const { row, channelId } = resolved;
    if (targetId === row.ownerId) {
      return this.record(ctx, channelId, 'kick', { status: 'refused', message: 'You cannot kick yourself; delete the channel by leaving it.' });
    }
    const occupants = (await this.gateway.occupantsOf(channelId)) ?? [];
    if (!occupants.includes(targetId)) {
      return this.record(ctx, channelId, 'kick', { status: 'noop', message: 'That member is not in your channel.' });
    }
    // Role hierarchy is checked before the call so a refusal reads as a
    // refusal, rather than as a 403 discord.js swallows into a rejected promise.
    if (!(await this.gateway.canMove(ctx.guildId, targetId))) {
      return this.record(ctx, channelId, 'kick', { status: 'refused', message: 'I cannot move that member - they outrank me.' });
    }
    await this.gateway.moveMember(ctx.guildId, targetId, null);
    return this.record(ctx, channelId, 'kick', { status: 'ok', message: `Removed <@${targetId}> from the channel.` });
  }

  /** Only available once the recorded owner has actually left the channel. */
  async claim(ctx: ControlContext): Promise<ControlOutcome> {
    return this.changeOwner('claim', ctx, ctx.actorId);
  }

  async transfer(ctx: ControlContext, targetId: string): Promise<ControlOutcome> {
    return this.changeOwner('transfer', ctx, targetId);
  }

  private async changeOwner(control: 'claim' | 'transfer', ctx: ControlContext, targetId: string): Promise<ControlOutcome> {
    const result = await this.store.withOwnershipLock(ctx.guildId, async (assertHeld) => {
      // Resolve AFTER serialization: a previously read owner is not authority
      // to clear grants or transfer somebody else's newly claimed channel.
      const resolved = await this.resolve(control, ctx, { requireOwner: control === 'transfer' });
      if (!resolved.ok) return resolved.outcome;
      const { row, channelId } = resolved;
      if (targetId === row.ownerId) {
        return this.record(ctx, channelId, control, { status: 'noop', message: 'You already own this channel.' });
      }
      const occupants = (await this.gateway.occupantsOf(channelId)) ?? [];
      if (!occupants.includes(ctx.actorId)) {
        return this.record(ctx, channelId, control, { status: 'refused', message: 'You are no longer in this channel.' });
      }
      if (control === 'claim' && occupants.includes(row.ownerId)) {
        return this.record(ctx, channelId, control, { status: 'refused', message: `<@${row.ownerId}> is still here, so the channel cannot be claimed.` });
      }
      if (!occupants.includes(targetId)) {
        return this.record(ctx, channelId, control, { status: 'refused', message: 'You can only hand the channel to somebody currently in it.' });
      }
      if (!(await this.store.beginOwnerChange(row.id, row.ownerId, targetId))) {
        return this.record(ctx, channelId, control, { status: 'refused', message: 'Channel ownership changed. No permissions were modified.' });
      }
      const completed = await this.applyOwnerChange({ ...row, pendingOwnerId: targetId }, channelId, assertHeld);
      return this.record(ctx, channelId, control, completed
        ? { status: 'ok', message: `<@${targetId}> now owns this channel.` }
        : { status: 'refused', message: 'Ownership change could not finish. It is saved for recovery; controls are unavailable until it completes.' });
    });
    return result.acquired ? result.value : { status: 'refused', message: 'Another ownership change is in progress. Try again shortly.' };
  }

  /**
   * Finish a committed intent under the ownership lock, also after a restart.
   * Revoke BEFORE granting: a failed/ambiguous grant can leave zero owners or
   * the intended owner, never both. Keep the intent until every step succeeds.
   */
  private async applyOwnerChange(row: TempVoiceRow, channelId: string, assertHeld: () => Promise<void>): Promise<boolean> {
    const targetId = row.pendingOwnerId!;
    try {
      await assertHeld();
      await this.gateway.clearOverwrite(channelId, row.ownerId);
      await assertHeld();
      await this.gateway.applyOverwrite(channelId, {
        id: targetId,
        type: 'member',
        allow: ['ViewChannel', 'Connect', 'Speak', 'ManageChannels', 'MoveMembers'],
      });
      await assertHeld();
      if (!(await this.store.completeOwnerChange(row.id, row.ownerId, targetId))) {
        throw new Error('temp-voice ownership finalization lost its persisted intent');
      }
      return true;
    } catch (err) {
      log.error('temp_voice_owner_change_pending', { guildId: row.guildId, channelId, ownerId: row.ownerId, targetId, err: String(err) });
      await this.store.audit(
        { guildId: row.guildId, actorId: null, channelId, action: 'owner_change', outcome: 'pending', reason: String(err).slice(0, 300) },
        this.iso(),
      );
      return false;
    }
  }

  private async recoverOwnerChange(guildId: string, channelId: string): Promise<boolean> {
    const result = await this.store.withOwnershipLock(guildId, async (assertHeld) => {
      const row = await this.store.getByChannel(guildId, channelId);
      if (!row || row.pendingOwnerId === null) return true;
      return this.applyOwnerChange(row, channelId, assertHeld);
    });
    return result.acquired && result.value;
  }
}

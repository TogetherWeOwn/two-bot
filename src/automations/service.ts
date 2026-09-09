/**
 * The automations service layer (TOG-1648): validation and orchestration for
 * custom commands, scheduled messages and stickies.
 *
 * Everything the admin surface can do lands here first. The store never
 * validates, the Discord layer never decides, and the audit row is written by
 * the same code path for every outcome - success and failure alike - so a
 * rejected definition still leaves a trail.
 *
 * Authorisation model, so it is written down once:
 *
 *   * Slash commands: Discord's own Default Member Permissions, set to
 *     ManageGuild on every automation command. Discord enforces it before the
 *     interaction ever reaches us; we re-check in code for the staging proof
 *     (negative evidence needs a real refusal, not a UI that hides a button).
 *   * Internal actions (import/export): the shared-secret model from
 *     docs/INTERNAL_ACTIONS.md, unchanged.
 *
 * The bot posts every automation message with `allowed_mentions: {parse: []}`,
 * for the same reason announcement.post does: an admin template is not a
 * licence to @everyone on a live server.
 */
import { randomUUID } from 'node:crypto';
import { CommandCapacityError } from './errors.ts';
import type { AutomationStore } from './store.ts';
import { validateTemplate } from './template.ts';
import { translateExport } from './mee6.ts';
import { BUILTIN_COMMAND_NAMES, MAX_CUSTOM_COMMANDS } from '../discord/commandNames.ts';

const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const TRIGGER_PATTERN = /^![a-z0-9_-]{1,32}$/;
const MAX_BODY = 2000;

export interface AutomationDiscord {
  /** Post a message to a channel; returns the message id. */
  postMessage(channelId: string, content: string): Promise<string>;
  /** Delete one message (the previous sticky). */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
}

export interface PutCommandInput {
  guildId: string;
  name: string;
  description: string;
  template: string;
  textTrigger?: string | null;
  enabled?: boolean;
  actorId: string;
}

export interface PutScheduledInput {
  guildId: string;
  /** Caller-supplied id; import reuses the MEE6-derived one, admin sets a fresh one. */
  id: string;
  channelId: string;
  body: string;
  nextRunAt: string;
  intervalSeconds?: number | null;
  enabled?: boolean;
  actorId: string;
}

export interface PutStickyInput {
  guildId: string;
  channelId: string;
  body: string;
  debounceSeconds?: number;
  enabled?: boolean;
  actorId: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requirePattern(value: string, pattern: RegExp, what: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${what} must match ${pattern}.`);
  }
}

function requireBody(body: string, what: string): void {
  if (body.length < 1 || body.length > MAX_BODY) {
    throw new Error(`${what} must be between 1 and ${MAX_BODY} characters.`);
  }
}

function safeErrorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 120) : typeof err;
}

function retryDelayMs(err: unknown): number | null {
  const e = err as { retryable?: boolean; retryAfterMs?: number };
  if (!e?.retryable) return null;
  return Math.min(Math.max(Number(e.retryAfterMs) || 30_000, 1_000), 15 * 60_000);
}

function validateCommandInput(input: PutCommandInput): void {
  requirePattern(input.name, NAME_PATTERN, 'Command name');
  if (BUILTIN_COMMAND_NAMES.has(input.name)) {
    throw new Error(`Command name "${input.name}" is reserved by Owen.`);
  }
  if (input.description.length < 1 || input.description.length > 100) {
    throw new Error('Description must be between 1 and 100 characters.');
  }
  validateTemplate(input.template);
  if (input.textTrigger != null) {
    requirePattern(input.textTrigger, TRIGGER_PATTERN, 'Text trigger');
    if (input.textTrigger !== input.textTrigger.toLowerCase()) {
      throw new Error('Text trigger must be lowercase.');
    }
  }
}

export class AutomationService {
  private store: AutomationStore;
  private discord: AutomationDiscord;
  private now: () => string;

  constructor(store: AutomationStore, discord: AutomationDiscord, now: () => string = nowIso) {
    this.store = store;
    this.discord = discord;
    this.now = now;
  }

  // --- custom commands ------------------------------------------------------

  async putCommand(input: PutCommandInput): Promise<{ created: boolean }> {
    const at = this.now();
    let existing: Awaited<ReturnType<AutomationStore['getCommand']>> = null;
    try {
      existing = await this.store.getCommand(input.guildId, input.name);
      validateCommandInput(input);
      const result = await this.store.withCommandCapacity(
        input.guildId,
        async (locked) => {
          const current = await locked.getCommand(input.guildId, input.name);
          if (!current && (await locked.listCommands(input.guildId)).length >= MAX_CUSTOM_COMMANDS) {
            throw new CommandCapacityError(
              `Write would define more than ${MAX_CUSTOM_COMMANDS} custom commands, but that is the guild limit.`,
            );
          }
          await locked.putCommand({
            guildId: input.guildId,
            name: input.name,
            description: input.description,
            template: input.template,
            textTrigger: input.textTrigger ?? null,
            enabled: input.enabled ?? true,
            createdBy: current?.createdBy ?? input.actorId,
            createdAt: current?.createdAt ?? at,
            updatedBy: input.actorId,
            updatedAt: at,
          });
          return { created: !current };
        },
      );
      await this.store.audit(
        {
          guildId: input.guildId,
          actorId: input.actorId,
          action: result.created ? 'command.create' : 'command.update',
          targetKey: input.name,
          outcome: 'ok',
        },
        at,
      );
      return result;
    } catch (err) {
      if (!existing) {
        existing = await this.store.getCommand(input.guildId, input.name).catch(() => null);
      }
      await this.store.audit(
        {
          guildId: input.guildId,
          actorId: input.actorId,
          action: existing ? 'command.update' : 'command.create',
          targetKey: input.name,
          outcome: 'rejected',
          reason: safeErrorName(err),
        },
        at,
      );
      throw err;
    }
  }

  async deleteCommand(guildId: string, name: string, actorId: string): Promise<boolean> {
    const gone = await this.store.deleteCommand(guildId, name);
    await this.store.audit(
      {
        guildId,
        actorId,
        action: 'command.delete',
        targetKey: name,
        outcome: gone ? 'ok' : 'absent',
      },
      this.now(),
    );
    return gone;
  }

  // --- scheduled messages ---------------------------------------------------

  async putScheduled(input: PutScheduledInput): Promise<{ created: boolean }> {
    const now = this.now();
    let existing: Awaited<ReturnType<AutomationStore['getScheduled']>> = null;
    try {
      existing = await this.store.getScheduled(input.guildId, input.id);
      requireBody(input.body, 'Message body');
      if (input.intervalSeconds != null) {
        if (input.intervalSeconds < 60 || input.intervalSeconds > 31_536_000) {
          throw new Error('Interval must be between 60 seconds and 365 days.');
        }
      }
      const at = Date.parse(input.nextRunAt);
      if (Number.isNaN(at)) {
        throw new Error('nextRunAt must be an ISO-8601 timestamp.');
      }
      const nextRunAt = new Date(at).toISOString();
      const written = await this.store.putScheduled({
        id: input.id,
        guildId: input.guildId,
        channelId: input.channelId,
        body: input.body,
        nextRunAt,
        intervalSeconds: input.intervalSeconds ?? null,
        enabled: input.enabled ?? true,
        lastRunAt: existing?.lastRunAt ?? null,
        lastMessageId: existing?.lastMessageId ?? null,
        createdBy: existing?.createdBy ?? input.actorId,
        createdAt: existing?.createdAt ?? now,
        updatedBy: input.actorId,
        updatedAt: now,
        claimToken: existing?.claimToken ?? null,
        claimedAt: existing?.claimedAt ?? null,
      });
      if (!written) {
        throw new Error('Scheduled message id belongs to another guild.');
      }
    } catch (err) {
      await this.store.audit(
        {
          guildId: input.guildId,
          actorId: input.actorId,
          action: existing ? 'scheduled.update' : 'scheduled.create',
          targetKey: input.id,
          outcome: 'rejected',
          reason: safeErrorName(err),
        },
        now,
      );
      throw err;
    }
    await this.store.audit(
      {
        guildId: input.guildId,
        actorId: input.actorId,
        action: existing ? 'scheduled.update' : 'scheduled.create',
        targetKey: input.id,
        outcome: 'ok',
      },
      now,
    );
    return { created: !existing };
  }

  async deleteScheduled(guildId: string, id: string, actorId: string): Promise<boolean> {
    const gone = await this.store.deleteScheduled(guildId, id);
    await this.store.audit(
      {
        guildId,
        actorId,
        action: 'scheduled.delete',
        targetKey: id,
        outcome: gone ? 'ok' : 'absent',
      },
      this.now(),
    );
    return gone;
  }

  /**
   * Fire up to ten due rows. Claim exactly one occurrence immediately before
   * posting it: a slow serial batch must not lease later rows so early that a
   * second scheduler can reclaim and send them before this worker reaches them.
   * Transient Discord failures retain the occurrence for a bounded retry;
   * permanent failures advance/disable it so a deleted channel cannot wedge the
   * queue forever.
   */
  async runDueScheduled(guildId: string, nowIsoValue?: string): Promise<number> {
    let fired = 0;
    for (let attempted = 0; attempted < 10; attempted++) {
      const now = nowIsoValue ?? this.now();
      const claimToken = randomUUID();
      // Discord requests abort after 15 seconds; one minute leaves ample margin
      // for this one outbound call while still recovering after a process crash.
      const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
      const [row] = await this.store.claimDueScheduled(guildId, now, claimToken, leaseUntil, 1);
      if (!row) break;

      try {
        const messageId = await this.discord.postMessage(row.channelId, row.body);
        const completed = await this.store.markScheduledRun(guildId, row.id, now, messageId, claimToken);
        if (!completed) {
          // The definition was changed or cancelled while Discord was posting.
          // Its completion no longer owns the row, so remove the now-orphaned
          // message rather than letting a cancelled/stale occurrence survive.
          await this.discord.deleteMessage(row.channelId, messageId).catch(() => {});
          await this.store.audit(
            {
              guildId: row.guildId, actorId: null, action: 'scheduled.run',
              targetKey: row.id, outcome: 'stale_completion',
            },
            now,
          );
          continue;
        }
        await this.store.audit(
          { guildId: row.guildId, actorId: null, action: 'scheduled.run', targetKey: row.id, outcome: 'ok' },
          now,
        );
        fired++;
      } catch (err) {
        const retryAfterMs = retryDelayMs(err);
        if (retryAfterMs !== null) {
          const retryAt = new Date(Date.parse(now) + retryAfterMs).toISOString();
          const retained = await this.store.retryScheduled(guildId, row.id, claimToken, retryAt);
          if (!retained) continue;
          await this.store.audit(
            {
              guildId: row.guildId,
              actorId: null,
              action: 'scheduled.run',
              targetKey: row.id,
              outcome: 'retry_scheduled',
              reason: safeErrorName(err),
            },
            now,
          );
          continue;
        }
        const completed = await this.store.markScheduledRun(guildId, row.id, now, null, claimToken);
        if (!completed) continue;
        await this.store.audit(
          {
            guildId: row.guildId,
            actorId: null,
            action: 'scheduled.run',
            targetKey: row.id,
            outcome: 'post_failed',
            reason: safeErrorName(err),
          },
          now,
        );
      }
    }
    return fired;
  }

  // --- stickies ---------------------------------------------------------------

  async putSticky(input: PutStickyInput): Promise<{ created: boolean }> {
    const now = this.now();
    let existing: Awaited<ReturnType<AutomationStore['getSticky']>> = null;
    try {
      existing = await this.store.getSticky(input.guildId, input.channelId);
      requireBody(input.body, 'Sticky body');
      const debounce = input.debounceSeconds ?? 5;
      if (debounce < 1 || debounce > 300) {
        throw new Error('Debounce must be between 1 and 300 seconds.');
      }
      await this.store.putSticky({
        guildId: input.guildId,
        channelId: input.channelId,
        body: input.body,
        debounceSeconds: debounce,
        enabled: input.enabled ?? true,
        lastMessageId: existing?.lastMessageId ?? null,
        lastPostedAt: existing?.lastPostedAt ?? null,
        createdBy: existing?.createdBy ?? input.actorId,
        createdAt: existing?.createdAt ?? now,
        updatedBy: input.actorId,
        updatedAt: now,
        claimToken: existing?.claimToken ?? null,
        claimedAt: existing?.claimedAt ?? null,
      });
    } catch (err) {
      await this.store.audit(
        {
          guildId: input.guildId,
          actorId: input.actorId,
          action: existing ? 'sticky.update' : 'sticky.create',
          targetKey: input.channelId,
          outcome: 'rejected',
          reason: safeErrorName(err),
        },
        now,
      );
      throw err;
    }
    await this.store.audit(
      {
        guildId: input.guildId,
        actorId: input.actorId,
        action: existing ? 'sticky.update' : 'sticky.create',
        targetKey: input.channelId,
        outcome: 'ok',
      },
      now,
    );
    return { created: !existing };
  }

  async deleteSticky(guildId: string, channelId: string, actorId: string): Promise<boolean> {
    // Read the row before deleting it: the live message id only exists while
    // the row does, and cleaning up the pinned copy is best-effort - the row
    // is already gone, so a failure here must not resurrect it.
    const existing = await this.store.getSticky(guildId, channelId);
    const gone = await this.store.deleteSticky(guildId, channelId);
    if (gone && existing?.lastMessageId) {
      await this.discord.deleteMessage(channelId, existing.lastMessageId).catch(() => {});
    }
    await this.store.audit(
      {
        guildId,
        actorId,
        action: 'sticky.delete',
        targetKey: channelId,
        outcome: gone ? 'ok' : 'absent',
      },
      this.now(),
    );
    return gone;
  }

  /**
   * Member activity landed in a channel with a sticky. If the previous sticky
   * is older than the debounce window, un-stick it and post a fresh copy so
   * the sticky sits at the bottom of the conversation again (StickyBot
   * behaviour).
   *
   * The caller hands us only metadata - channel id, author id, timestamp -
   * which is the whole point: this works without reading message content.
   */
  async onChannelActivity(
    guildId: string,
    channelId: string,
    actorMemberId: string,
    atMs: number,
  ): Promise<'reposted' | 'held' | 'none'> {
    const existing = await this.store.getSticky(guildId, channelId);
    if (!existing?.enabled) return 'none';
    const postedAt = new Date(atMs).toISOString();
    const cutoff = new Date(atMs - existing.debounceSeconds * 1000).toISOString();
    const claimToken = randomUUID();
    const expiredClaimCutoff = new Date(atMs - 60_000).toISOString();
    const sticky = await this.store.claimStickyPost(
      guildId, channelId, claimToken, postedAt, cutoff, expiredClaimCutoff,
    );
    if (!sticky) return 'held';
    let replacementMessageId: string | null = null;
    try {
      replacementMessageId = await this.discord.postMessage(channelId, sticky.body);
      const recorded = await this.store.recordStickyPost(
        guildId, channelId, replacementMessageId, postedAt, claimToken,
      );
      if (!recorded) {
        await this.discord.deleteMessage(channelId, replacementMessageId).catch(() => {});
        return 'held';
      }
      if (sticky.lastMessageId) {
        await this.discord.deleteMessage(channelId, sticky.lastMessageId).catch(() => {});
      }
      await this.store.audit(
        { guildId, actorId: actorMemberId || null, action: 'sticky.run', targetKey: channelId, outcome: 'ok' },
        postedAt,
      );
      return 'reposted';
    } catch (err) {
      // If Discord accepted the replacement but persistence failed or threw, it
      // is not the durable sticky and must not be left as an orphan post.
      if (replacementMessageId) {
        await this.discord.deleteMessage(channelId, replacementMessageId).catch(() => {});
      }
      await this.store.releaseStickyPost(guildId, channelId, claimToken);
      await this.store.audit(
        {
          guildId,
          actorId: actorMemberId || null,
          action: 'sticky.run',
          targetKey: channelId,
          outcome: 'post_failed',
          reason: safeErrorName(err),
        },
        postedAt,
      );
      throw err;
    }
  }

  /** Audit one member-facing custom command around rendering and delivery. */
  async runCommand<T>(
    guildId: string,
    commandName: string,
    actorMemberId: string,
    deliver: () => Promise<T>,
  ): Promise<T> {
    const at = this.now();
    try {
      const result = await deliver();
      await this.store.audit(
        { guildId, actorId: actorMemberId || null, action: 'command.run', targetKey: commandName, outcome: 'ok' },
        at,
      );
      return result;
    } catch (err) {
      await this.store.audit(
        {
          guildId,
          actorId: actorMemberId || null,
          action: 'command.run',
          targetKey: commandName,
          outcome: 'failed',
          reason: safeErrorName(err),
        },
        at,
      );
      throw err;
    }
  }

  /** The one posting path the text-trigger gateway uses. */
  postTextReply(
    guildId: string,
    channelId: string,
    commandName: string,
    actorMemberId: string,
    content: string | (() => string),
  ): Promise<string> {
    return this.runCommand(
      guildId,
      commandName,
      actorMemberId,
      () => this.discord.postMessage(channelId, typeof content === 'function' ? content() : content),
    );
  }

  // --- MEE6 import/export -----------------------------------------------------

  /**
   * Import an MEE6 export. Translation assigns deterministic target names, so
   * retrying the same content converges on the same rows. Every translated row
   * then uses putCommand, keeping validation identical to the admin path.
   */
  async importMee6(
    guildId: string,
    commands: unknown[],
    actorId: string,
    options: { overwrite?: boolean; maxCommands?: number } = {},
  ): Promise<{ imported: number; skipped: number; conflicts: string[] }> {
    const validInputs: Parameters<typeof translateExport>[0] = [];
    let invalid = 0;
    for (const raw of commands) {
      if (typeof raw !== 'object' || raw === null) {
        invalid++;
        continue;
      }
      const row = raw as Record<string, unknown>;
      const command = row.command ?? row.name;
      const response = row.response ?? row.message ?? row.content;
      if (typeof command !== 'string' || typeof response !== 'string') {
        invalid++;
        continue;
      }
      validInputs.push({
        command,
        response,
        description: typeof row.description === 'string' ? row.description : undefined,
      });
    }

    const translated = translateExport(validInputs);
    let imported = 0;
    let skipped = invalid;
    const conflicts = [...translated.conflicts];
    const commandAudits: Array<{ action: 'command.create' | 'command.update'; name: string; at: string }> = [];
    const maxCommands = options.maxCommands ?? MAX_CUSTOM_COMMANDS;

    try {
      await this.store.withCommandCapacity(guildId, async (locked) => {
        const existingRows = await locked.listCommands(guildId);
        const validCommands = translated.commands.filter((command) => {
          try {
            validateCommandInput({
              guildId,
              name: command.name,
              description: command.description,
              template: command.template,
              textTrigger: command.textTrigger,
              actorId,
            });
            return true;
          } catch {
            skipped++;
            return false;
          }
        });
        const existingNames = new Set(existingRows.map((command) => command.name));
        for (const command of validCommands) existingNames.add(command.name);
        if (existingNames.size > maxCommands) {
          throw new CommandCapacityError(
            `Import would define ${existingNames.size} custom commands, but the guild limit is ${maxCommands}.`,
          );
        }

        for (const command of validCommands) {
          const at = this.now();
          const input: PutCommandInput = {
            guildId,
            name: command.name,
            description: command.description,
            template: command.template,
            textTrigger: command.textTrigger,
            actorId,
          };
          validateCommandInput(input);

          const existing = await locked.getCommand(guildId, command.name);
          const sameImport =
            existing?.description === command.description &&
            existing.template === command.template &&
            existing.textTrigger === command.textTrigger;
          if (existing && !sameImport && !options.overwrite) {
            conflicts.push(command.name);
            skipped++;
            continue;
          }

          if (command.textTrigger) {
            const triggerOwner = await locked.getCommandByTextTrigger(guildId, command.textTrigger);
            if (triggerOwner && triggerOwner.name !== command.name) {
              conflicts.push(command.name);
              skipped++;
              continue;
            }
          }

          await locked.putCommand({
            guildId,
            name: command.name,
            description: command.description,
            template: command.template,
            textTrigger: command.textTrigger,
            enabled: existing?.enabled ?? true,
            createdBy: existing?.createdBy ?? actorId,
            createdAt: existing?.createdAt ?? at,
            updatedBy: actorId,
            updatedAt: at,
          });
          commandAudits.push({ action: existing ? 'command.update' : 'command.create', name: command.name, at });
          imported++;
        }
      });
    } catch (err) {
      await this.store.audit(
        {
          guildId,
          actorId,
          action: 'mee6.import',
          targetKey: null,
          outcome: 'rejected',
          reason: safeErrorName(err),
        },
        this.now(),
      );
      throw err;
    }

    for (const audit of commandAudits) {
      await this.store.audit(
        {
          guildId,
          actorId,
          action: audit.action,
          targetKey: audit.name,
          outcome: 'ok',
        },
        audit.at,
      );
    }
    await this.store.audit(
      {
        guildId,
        actorId,
        action: 'mee6.import',
        targetKey: null,
        outcome: `imported:${imported},skipped:${skipped},conflicts:${conflicts.length}`,
      },
      this.now(),
    );
    return { imported, skipped, conflicts };
  }

  /** Every command definition in MEE6's export shape. */
  async exportCommands(guildId: string): Promise<unknown[]> {
    const rows = await this.store.listCommands(guildId);
    return rows.map((r) => ({
      command: r.name,
      description: r.description,
      response: r.template,
    }));
  }
}

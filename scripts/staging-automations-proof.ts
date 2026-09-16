/**
 * TOG-1648 staging proof: custom commands, scheduled messages, sticky
 * messages, exercised against the real TWO Staging guild through the real
 * service + store, on the real staging Postgres.
 *
 *   DISCORD_STAGING_BOT_TOKEN=... TWO_DATABASE_URL=<staging> \
 *     node scripts/staging-automations-proof.ts
 *
 * Positive, negative, permission/hierarchy, and idempotency evidence for the
 * board card. Every artefact it creates it also removes: rows are deleted,
 * messages are deleted, and the audit log is left as the only trace (which is
 * the point of the audit log).
 *
 * The channel is #bot-log - not member-facing, already the bot's own dump.
 */
import { EventEmitter } from 'node:events';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { openDb } from '../src/store/db.ts';
import {
  AutomationStore,
  type AutomationCommandRow,
  type ScheduledMessageRow,
  type StickyMessageRow,
} from '../src/automations/store.ts';
import { AutomationService } from '../src/automations/service.ts';
import {
  AutomationDiscord,
  DiscordPostError,
  registerAutomationCommands,
} from '../src/automations/discord.ts';
import { registerAutomationGateway } from '../src/automations/gateway.ts';
import { cleanupDecision, restoredStickyRow } from './staging-automations-proof-state.ts';

const GUILD = '1545644954272137297'; // TWO Staging
const CHANNEL = '1546451670500642826'; // #bot-log
const ACTOR = 'staging-proof:tog-1648';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
const dbUrl = process.env.TWO_DATABASE_URL;
if (!token || !dbUrl) {
  console.error('need DISCORD_STAGING_BOT_TOKEN and TWO_DATABASE_URL (the staging db)');
  process.exit(2);
}

interface Row {
  name: string;
  pass: boolean;
  detail: string;
}
const results: Row[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};
const recordCleanupFailure = (name: string, error: unknown) => {
  check(`cleanup.${name}`, false, error instanceof Error ? error.message : String(error));
};
const sameCommand = (actual: AutomationCommandRow | null, expected: AutomationCommandRow | null) =>
  JSON.stringify(actual) === JSON.stringify(expected);
const sameScheduled = (actual: ScheduledMessageRow | null, expected: ScheduledMessageRow | null) =>
  JSON.stringify(actual) === JSON.stringify(expected);
const sameSticky = (actual: StickyMessageRow | null, expected: StickyMessageRow | null) =>
  JSON.stringify(actual) === JSON.stringify(expected);

const db = await openDb(dbUrl, { applicationName: 'tog-1648-staging-proof' });
const store = new AutomationStore(db);
const discord = new AutomationDiscord({ token });
const svc = new AutomationService(store, discord);

const commandNames = ['tog1648proof', 'faq', 'faq2', 'faq3', 'collision', 'collision-2', 'rulesinfo'];
const priorCommands = new Map<string, AutomationCommandRow>();
for (const name of commandNames) {
  const prior = await store.getCommand(GUILD, name);
  if (prior) priorCommands.set(name, prior);
}
const priorScheduled = await store.getScheduled(GUILD, 'tog-1648-proof-sched');
const priorSticky = await store.getSticky(GUILD, CHANNEL);
const proofCommands = new Map<string, AutomationCommandRow | null>();
let proofScheduled: ScheduledMessageRow | null = null;
let proofSticky: StickyMessageRow | null = null;
const createdMessageIds = new Set<string>();
let priorStickyMessageReplaced = false;
const rememberMessage = (messageId: string | null | undefined) => {
  if (messageId) createdMessageIds.add(messageId);
};

try {
  // --- 1. custom command CRUD + template -------------------------------
  const created = await svc.putCommand({
    guildId: GUILD, name: 'tog1648proof', description: 'TOG-1648 staging proof',
    template: 'Hello {server} from the {channel} proof command', textTrigger: '!tog1648proof',
    actorId: ACTOR,
  });
  check('command.create', created.created === true, 'row created via service');

  const row = await store.getCommand(GUILD, 'tog1648proof');
  check('command.readback', row?.template === 'Hello {server} from the {channel} proof command', 'readback matches');

  // The reply the gateway would post for the trigger, posted for real.
  const reply = await svc.postTextReply(
    GUILD,
    CHANNEL,
    'tog1648proof',
    ACTOR,
    row!.template.replace('{server}', 'TWO Staging').replace('{channel}', '#bot-log'),
  );
  rememberMessage(reply);
  check('command.fire', /^\d{17,}$/.test(reply), `posted message ${reply}`);

  // Exercise the production gateway listener seam, after its automod-accepted
  // handoff, against the real Discord REST client.
  const gatewayBus = new EventEmitter();
  registerAutomationGateway(gatewayBus as unknown as Client, {
    guildId: GUILD,
    service: {
      onChannelActivity: async () => 'none',
      postTextReply: async (...args: Parameters<AutomationService['postTextReply']>) => {
        const messageId = await svc.postTextReply(...args);
        rememberMessage(messageId);
        return messageId;
      },
    } as unknown as AutomationService,
    textCommandsEnabled: true,
    findTrigger: (guildId, word) => store.findTextTrigger(guildId, word),
  });
  await Promise.all(gatewayBus.listeners('automationMessageAccepted').map((listener) => listener({
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    content: '!tog1648proof',
    createdTimestamp: Date.now(),
  })));
  const gatewayMessage = (await db.prepare(
    `SELECT target_key FROM automation_audit_log
      WHERE guild_id = ? AND actor_id = ? AND action = 'command.run'
      ORDER BY created_at DESC LIMIT 1`,
  ).get<{ target_key: string }>(GUILD, ACTOR))?.target_key;
  check('gateway.production-seam', gatewayMessage === 'tog1648proof', 'accepted gateway event ran the custom command');

  // --- 2. MEE6 import/export round trip --------------------------------
  const imp = await svc.importMee6(GUILD, [
    { command: 'faq', response: 'Read {channel} rules, {user}!' },
    '',
    { command: 'Rules & Info', response: 'second shape' },
  ], ACTOR);
  const repeated = await svc.importMee6(GUILD, [
    { command: 'faq', response: 'Read {channel} rules, {user}!' },
    { command: 'Rules & Info', response: 'second shape' },
  ], ACTOR);
  check('mee6.import', imp.imported === 2 && imp.skipped === 1 && repeated.imported === 2,
    `first imported=${imp.imported} skipped=${imp.skipped}; repeat imported=${repeated.imported}`);

  const faq = await store.getCommand(GUILD, 'faq');
  const faq2 = await store.getCommand(GUILD, 'faq2');
  check('mee6.converges', faq?.textTrigger === '!faq' && !faq2,
    `faq keeps !faq; repeat leaves no silently suffixed faq2 row`);

  const collision = await svc.importMee6(GUILD, [
    { command: 'collision', response: 'first' },
    { command: 'Collision!', response: 'second' },
  ], ACTOR);
  const collisionFirst = await store.getCommand(GUILD, 'collision');
  const collisionSecond = await store.getCommand(GUILD, 'collision-2');
  check(
    'mee6.collision',
    collision.imported === 2 && collision.conflicts.includes('collision')
      && collisionFirst?.textTrigger === '!collision' && collisionSecond?.textTrigger === null,
    `imported=${collision.imported}; conflicts=${collision.conflicts.join(',')}; triggers=${collisionFirst?.textTrigger},${collisionSecond?.textTrigger}`,
  );

  const exported = await svc.exportCommands(GUILD);
  check('mee6.export', Array.isArray(exported) && exported.length >= 4, `export returns ${exported.length} commands`);

  // --- 3. negative: two commands cannot claim one trigger --------------
  let dupTriggerRejected = false;
  try {
    await svc.putCommand({ guildId: GUILD, name: 'tog1648dup', description: 'dup',
      template: 'x', textTrigger: '!tog1648proof', actorId: ACTOR });
  } catch { dupTriggerRejected = true; }
  check('trigger.unique', dupTriggerRejected, 'second command with !tog1648proof rejected');

  let badNameRejected = false;
  try {
    await svc.putCommand({ guildId: GUILD, name: 'Bad Name!', description: 'd',
      template: 'x', textTrigger: null, actorId: ACTOR });
  } catch { badNameRejected = true; }
  check('name.validation', badNameRejected, 'invalid command name rejected');

  // Exercise the production interaction listener and its permission bit, not
  // only the service's validation seam.
  const permissionBus = new EventEmitter();
  registerAutomationCommands(permissionBus as unknown as Client, { guildId: GUILD, service: svc, store });
  const permissionReplies: unknown[] = [];
  await Promise.all(permissionBus.listeners('interactionCreate').map((listener) => listener({
    isChatInputCommand: () => true,
    commandName: 'command-list',
    inGuild: () => true,
    guildId: GUILD,
    user: { id: ACTOR },
    memberPermissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ManageMessages },
    reply: async (replyBody: unknown) => { permissionReplies.push(replyBody); },
  })));
  check(
    'permission.listener-refusal',
    JSON.stringify(permissionReplies).includes('Manage Server permission is required'),
    'production interaction listener rejects a non-ManageGuild permission mask',
  );

  // --- 4. scheduled message: one-shot fires once ------------------------
  const soon = new Date(Date.now() - 1000).toISOString();
  await svc.putScheduled({ guildId: GUILD, id: 'tog-1648-proof-sched', channelId: CHANNEL,
    body: 'TOG-1648 scheduled-message staging proof', nextRunAt: soon, intervalSeconds: null, actorId: ACTOR });
  const fired1 = await svc.runDueScheduled(GUILD);
  const fired2 = await svc.runDueScheduled(GUILD);
  const schedRow = await store.getScheduled(GUILD, 'tog-1648-proof-sched');
  rememberMessage(schedRow?.lastMessageId);
  check('scheduled.oneshot', fired1 === 1 && fired2 === 0 && schedRow?.enabled === false,
    `fired=${fired1} then ${fired2}, enabled=${schedRow?.enabled} (disables itself)`);

  // --- 5. sticky: post, debounce, repost --------------------------------
  await svc.putSticky({ guildId: GUILD, channelId: CHANNEL,
    body: 'TOG-1648 sticky staging proof', debounceSeconds: 3, enabled: true, actorId: ACTOR });
  const first = await svc.onChannelActivity(GUILD, CHANNEL, ACTOR, Date.now());
  if (first === 'reposted' && priorSticky?.lastMessageId) priorStickyMessageReplaced = true;
  rememberMessage((await store.getSticky(GUILD, CHANNEL))?.lastMessageId);
  const held = await svc.onChannelActivity(GUILD, CHANNEL, ACTOR, Date.now());
  check('sticky.repost', first === 'reposted', 'activity reposts the sticky');
  check('sticky.debounce', held === 'held', `second activity inside debounce held (${held})`);
  await new Promise((r) => setTimeout(r, 3100));
  const again = await svc.onChannelActivity(GUILD, CHANNEL, ACTOR, Date.now());
  if (again === 'reposted' && priorSticky?.lastMessageId) priorStickyMessageReplaced = true;
  rememberMessage((await store.getSticky(GUILD, CHANNEL))?.lastMessageId);
  check('sticky.after-debounce', again === 'reposted', 'activity after debounce reposts again');

  // --- 6. audit trail ----------------------------------------------------
  for (const name of commandNames) proofCommands.set(name, await store.getCommand(GUILD, name));
  proofScheduled = await store.getScheduled(GUILD, 'tog-1648-proof-sched');
  proofSticky = await store.getSticky(GUILD, CHANNEL);

  const audit = (await db
    .prepare(`SELECT action FROM automation_audit_log WHERE guild_id = ? ORDER BY created_at DESC LIMIT 200`)
    .all(GUILD)) as { action: string }[];
  const actions = new Set(audit.map((a) => a.action));
  const need = ['command.create', 'mee6.import', 'scheduled.run', 'sticky.create'];
  const missing = need.filter((a) => !actions.has(a));
  check('audit.covers', missing.length === 0, `audit has ${[...actions].sort().join(', ')}`);
} finally {
  // --- cleanup: restore exact pre-proof definitions ---------------------
  for (const name of commandNames) {
    try {
      const prior = priorCommands.get(name) ?? null;
      const current = await store.getCommand(GUILD, name);
      const proof = proofCommands.has(name)
        ? proofCommands.get(name) ?? null
        : current?.updatedBy === ACTOR ? current : null;
      if (cleanupDecision(current, { before: prior, proof }) === 'skip') {
        check(`cleanup.command.${name}.concurrent`, true, 'left a concurrent admin change untouched');
        continue;
      }
      await store.deleteCommand(GUILD, name);
      if (prior) await store.putCommand(prior);
      const restored = await store.getCommand(GUILD, name);
      check(`cleanup.command.${name}`, sameCommand(restored, prior),
        prior ? 'restored prior definition' : 'removed proof definition');
    } catch (error) {
      recordCleanupFailure(`command.${name}`, error);
    }
  }
  try {
    const currentScheduled = await store.getScheduled(GUILD, 'tog-1648-proof-sched');
    const scheduledProof = proofScheduled ?? (currentScheduled?.updatedBy === ACTOR ? currentScheduled : null);
    if (cleanupDecision(currentScheduled, { before: priorScheduled, proof: scheduledProof }) === 'skip') {
      check('cleanup.scheduled.concurrent', true, 'left a concurrent admin change untouched');
    } else {
      await store.deleteScheduled(GUILD, 'tog-1648-proof-sched');
      if (priorScheduled) {
        await db.prepare(
          `INSERT INTO scheduled_messages
             (id, guild_id, channel_id, body, next_run_at, interval_seconds, enabled,
              last_run_at, last_message_id, created_by, created_at, updated_by, updated_at,
              claim_token, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          priorScheduled.id, priorScheduled.guildId, priorScheduled.channelId, priorScheduled.body,
          priorScheduled.nextRunAt, priorScheduled.intervalSeconds, priorScheduled.enabled ? 1 : 0,
          priorScheduled.lastRunAt, priorScheduled.lastMessageId, priorScheduled.createdBy,
          priorScheduled.createdAt, priorScheduled.updatedBy, priorScheduled.updatedAt,
          priorScheduled.claimToken, priorScheduled.claimedAt,
        );
      }
      const restored = await store.getScheduled(GUILD, 'tog-1648-proof-sched');
      check('cleanup.scheduled', sameScheduled(restored, priorScheduled),
        priorScheduled ? 'restored prior definition' : 'removed proof definition');
    }
  } catch (error) {
    recordCleanupFailure('scheduled', error);
  }
  try {
    const currentSticky = await store.getSticky(GUILD, CHANNEL);
    const stickyProof = proofSticky ?? (currentSticky?.updatedBy === ACTOR ? currentSticky : null);
    if (cleanupDecision(currentSticky, { before: priorSticky, proof: stickyProof }) === 'skip') {
      check('cleanup.sticky.concurrent', true, 'left a concurrent admin change untouched');
      if (currentSticky?.lastMessageId) createdMessageIds.delete(currentSticky.lastMessageId);
    } else {
      await store.deleteSticky(GUILD, CHANNEL);
      let restoredSticky: StickyMessageRow | null = priorSticky;
      if (priorSticky) {
        let restoredStickyMessageId: string | null = null;
        const restoredAt = new Date().toISOString();
        if (priorSticky.enabled && priorStickyMessageReplaced) {
          restoredStickyMessageId = await discord.postMessage(CHANNEL, priorSticky.body);
          rememberMessage(restoredStickyMessageId);
        }
        const rowToRestore = restoredStickyRow(
          priorSticky,
          priorStickyMessageReplaced,
          restoredStickyMessageId,
          restoredAt,
        );
        restoredSticky = rowToRestore;
        await db.prepare(
          `INSERT INTO sticky_messages
             (guild_id, channel_id, body, debounce_seconds, enabled, last_message_id,
              last_posted_at, created_by, created_at, updated_by, updated_at, claim_token, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          rowToRestore.guildId, rowToRestore.channelId, rowToRestore.body, rowToRestore.debounceSeconds,
          rowToRestore.enabled ? 1 : 0, rowToRestore.lastMessageId, rowToRestore.lastPostedAt,
          rowToRestore.createdBy, rowToRestore.createdAt, rowToRestore.updatedBy, rowToRestore.updatedAt,
          rowToRestore.claimToken, rowToRestore.claimedAt,
        );
        if (restoredStickyMessageId) createdMessageIds.delete(restoredStickyMessageId);
      }
      const restored = await store.getSticky(GUILD, CHANNEL);
      check('cleanup.sticky', sameSticky(restored, restoredSticky),
        priorSticky ? 'restored prior definition with a coherent live message' : 'removed proof definition');
    }
  } catch (error) {
    recordCleanupFailure('sticky', error);
  }
  for (const messageId of createdMessageIds) {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await discord.deleteMessage(CHANNEL, messageId);
          break;
        } catch (error) {
          const retryAfterMs = error instanceof DiscordPostError ? error.retryAfterMs : null;
          if (attempt >= 2 || retryAfterMs === null) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        }
      }
    } catch (error) {
      recordCleanupFailure(`message.${messageId}`, error);
    }
  }
  try {
    await db.close();
  } catch (error) {
    recordCleanupFailure('database-close', error);
  }
}

const fails = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - fails}/${results.length} pass, ${fails} fail`);
process.exit(fails > 0 ? 1 : 0);

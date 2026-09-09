import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type Interaction,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Role,
  type StringSelectMenuInteraction,
  type User,
} from 'discord.js';
import { log } from '../core/log.ts';
import { parseSelfRoleCustomId, planSelfRoleChange, reactionOptionKey, selfRoleCustomId } from '../selfRoles/plan.ts';
import {
  findSelfRoleDisallowedPermission,
  findSelfRoleUnsafeChannelGrant,
  type SelfRoleChannelPermissions,
} from '../selfRoles/permissions.ts';
import type { SelfRoleAuditRow, SelfRolePanel, SelfRolePanelMode } from '../selfRoles/types.ts';
import type { SelfRoleClaim, SelfRolePanelClaim, SelfRoleStore } from '../store/selfRoleStore.ts';

export interface SelfRoleDeps {
  panels: SelfRolePanel[];
  store: SelfRoleStore;
  dryRun?: boolean;
}

const panelMemberLocks = new Map<string, Promise<void>>();

export function buildSelfRoleComponents(panel: SelfRolePanel, heldRoleIds: readonly string[] = []) {
  if (panel.mode === 'reaction') return [];
  const held = new Set(heldRoleIds);
  if (panel.mode === 'select') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(selfRoleCustomId(panel.id))
      .setPlaceholder(panel.color ? 'Choose your color' : 'Choose your roles')
      .setMinValues(0)
      .setMaxValues(panel.exclusive ? 1 : panel.options.length)
      .addOptions(
        panel.options.map((option) => {
          const builder = new StringSelectMenuOptionBuilder()
            .setLabel(option.label)
            .setValue(option.key)
            .setDefault(held.has(option.roleId));
          if (option.description) builder.setDescription(option.description);
          if (option.emoji) builder.setEmoji(option.emoji);
          return builder;
        }),
      );
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const [index, option] of panel.options.entries()) {
    const rowIndex = Math.floor(index / 5);
    const button = new ButtonBuilder()
      .setCustomId(selfRoleCustomId(panel.id, option.key))
      .setLabel(option.label)
      .setStyle(held.has(option.roleId) ? ButtonStyle.Success : ButtonStyle.Secondary);
    if (option.emoji) button.setEmoji(option.emoji);
    (rows[rowIndex] ??= new ActionRowBuilder<ButtonBuilder>()).addComponents(button);
  }
  return rows;
}

export function registerSelfRoles(client: Client, deps: SelfRoleDeps): void {
  const panels = new Map(deps.panels.map((panel) => [panel.id, panel]));
  const reactionPanels = new Map(
    deps.panels.filter((panel) => panel.mode === 'reaction').map((panel) => [panel.messageId, panel]),
  );

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const parsed = parseSelfRoleCustomId(interaction.customId);
    if (!parsed) return;
    const panel = panels.get(parsed.panelId);
    if (!panel) return;
    try {
      await handleComponent(interaction, panel, parsed.optionKey, deps);
    } catch (err) {
      log.error('self_role_interaction_failed', {
        panelId: panel.id,
        memberId: interaction.user.id,
        customId: interaction.customId,
        err: String(err),
      });
      const content = 'The role action failed. Please try again.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => undefined);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });

  const onReaction = async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    remove: boolean,
  ) => {
    if (user.bot) return;
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        log.error('self_role_reaction_fetch_failed', { messageId: reaction.message.id, err: String(err) });
        return;
      }
    }
    const panel = reactionPanels.get(reaction.message.id);
    if (!panel || reaction.message.channelId !== panel.channelId) return;
    const optionKey = reactionOptionKey(panel, reaction.emoji);
    if (!optionKey) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    let member: GuildMember;
    try {
      member = await guild.members.fetch({ user: user.id, force: true });
    } catch (err) {
      log.error('self_role_member_fetch_failed', { panelId: panel.id, memberId: user.id, err: String(err) });
      return;
    }
    // Discord reaction events have no delivery id. Use a fresh audit id and let
    // the authoritative role plan make duplicate gateway deliveries no-ops.
    await applyChange({
      panel,
      member,
      optionKey,
      source: 'reaction',
      sourceId: panel.messageId,
      eventId: `reaction:${panel.messageId}:${user.id}:${randomUUID()}`,
      remove,
      deps,
    });
  };

  const containReaction = (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    remove: boolean,
  ) => {
    void onReaction(reaction, user, remove).catch((err) => log.error('self_role_reaction_failed', {
      messageId: reaction.message.id,
      memberId: user.id,
      remove,
      err: String(err),
    }));
  };
  client.on(Events.MessageReactionAdd, (reaction, user) => containReaction(reaction, user, false));
  client.on(Events.MessageReactionRemove, (reaction, user) => containReaction(reaction, user, true));
}

async function handleComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  panel: SelfRolePanel,
  optionKey: string | undefined,
  deps: SelfRoleDeps,
): Promise<void> {
  const member = interaction.member as GuildMember | null;
  if (!member || !interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.message.id !== panel.messageId || interaction.channelId !== panel.channelId) {
    await rejectComponent(interaction, panel, deps, 'wrong_message', 'This role control is not attached to its configured panel.');
    return;
  }

  if (interaction.isButton()) {
    if (!optionKey) {
      await rejectComponent(interaction, panel, deps, 'malformed_control', 'This role control is malformed.');
      return;
    }
    const option = panel.options.find((candidate) => candidate.key === optionKey);
    if (!option) {
      await rejectComponent(interaction, panel, deps, 'unknown_option', 'That role control is invalid.');
      return;
    }
    await applyChange({
      panel,
      member,
      optionKey,
      source: 'button',
      sourceId: interaction.message.id,
      eventId: interaction.id,
      remove: false,
      toggle: true,
      deps,
      reply: interaction,
    });
    return;
  }

  const selected = new Set(interaction.values);
  const unknown = [...selected].filter((key) => !panel.options.some((candidate) => candidate.key === key));
  if (unknown.length || (panel.exclusive && selected.size > 1)) {
    await rejectComponent(interaction, panel, deps, 'invalid_selection', 'That role selection is invalid.');
    return;
  }

  const desiredRoleIds = panel.options.filter((option) => selected.has(option.key)).map((option) => option.roleId);
  await applyRoleDelta({
    panel,
    member,
    source: 'select',
    sourceId: interaction.message.id,
    eventId: interaction.id,
    optionKey: interaction.values[0] ?? null,
    roleId: desiredRoleIds[0] ?? null,
    operation: 'replace',
    addRoleIds: desiredRoleIds,
    removeRoleIds: [],
    desiredRoleIds,
    deps,
    reply: interaction,
  });
}

async function applyChange(opts: {
  panel: SelfRolePanel;
  member: GuildMember;
  optionKey: string;
  source: SelfRolePanelMode;
  sourceId: string;
  eventId: string;
  remove: boolean;
  toggle?: boolean;
  deps: SelfRoleDeps;
  reply?: ButtonInteraction | StringSelectMenuInteraction;
}): Promise<void> {
  await applyRoleDelta({
    ...opts,
    roleId: opts.panel.options.find((option) => option.key === opts.optionKey)?.roleId ?? null,
    operation: opts.remove ? 'remove' : opts.panel.exclusive ? 'replace' : 'add',
    addRoleIds: [],
    removeRoleIds: [],
    requestedOptionKey: opts.optionKey,
    requestedRemove: opts.remove,
    requestedToggle: opts.toggle,
  });
}

export async function applyRoleDelta(opts: {
  panel: SelfRolePanel;
  member: GuildMember;
  source: SelfRolePanelMode;
  sourceId: string;
  eventId: string;
  optionKey: string | null;
  roleId: string | null;
  operation: 'add' | 'remove' | 'replace';
  addRoleIds: string[];
  removeRoleIds: string[];
  desiredRoleIds?: string[];
  requestedOptionKey?: string;
  requestedRemove?: boolean;
  requestedToggle?: boolean;
  deps: SelfRoleDeps;
  reply?: ButtonInteraction | StringSelectMenuInteraction;
}): Promise<void> {
  const run = async () => {
    const panelClaim = opts.panel.exclusive ? await acquirePanelClaim(opts) : null;
    try {
      let authoritativeMember: GuildMember;
      try {
        authoritativeMember = await opts.member.guild.members.fetch({ user: opts.member.id, force: true });
      } catch (err) {
        log.error('self_role_member_fetch_failed', { panelId: opts.panel.id, memberId: opts.member.id, err: String(err) });
        await auditRejected(opts, 'member_fetch_failed', String(err));
        if (opts.reply) await opts.reply.editReply({ content: 'I could not verify your current roles. Staff have been notified in the logs.' });
        return;
      }
      const heldRoleIds = new Set(authoritativeMember.roles.cache.keys());
      const initialPlan = recomputeDelta(opts, heldRoleIds);
      if (!initialPlan.ok) {
        if (opts.reply) await opts.reply.editReply({ content: 'That role control is invalid.' });
        return;
      }
      const intended = new Set(heldRoleIds);
      for (const roleId of initialPlan.removeRoleIds) intended.delete(roleId);
      for (const roleId of initialPlan.addRoleIds) intended.add(roleId);
      const claimed = await claim({
        ...opts,
        desiredRoleIds: [...intended].filter((id) => opts.panel.options.some((option) => option.roleId === id)),
        preMutationRoleIds: [...heldRoleIds].filter((id) => opts.panel.options.some((option) => option.roleId === id)),
      });
      if (!claimed) {
        if (opts.reply) await opts.reply.editReply({ content: 'This role request was already handled.' });
        return;
      }
      if (claimed.recovered) {
        log.info('self_role_dispatch_recovered', {
          eventId: opts.eventId,
          panelId: opts.panel.id,
          memberId: opts.member.id,
          generation: claimed.generation,
        });
      }
      await applyClaimedRoleDelta({ ...opts, desiredRoleIds: claimed.desiredRoleIds }, claimed, authoritativeMember, panelClaim);
    } finally {
      if (panelClaim && opts.deps.store.releasePanelClaim) {
        await opts.deps.store.releasePanelClaim(panelClaim);
      }
    }
  };
  if (opts.panel.exclusive && typeof opts.deps.store.claimPanel === 'function') await run();
  else await withPanelMemberLock(opts.member.guild.id, opts.member.id, opts.panel.id, run);
}

async function acquirePanelClaim(opts: Parameters<typeof applyRoleDelta>[0]): Promise<SelfRolePanelClaim | null> {
  if (!opts.deps.store.claimPanel) return null;
  let delayMs = 10;
  for (;;) {
    const claim = await opts.deps.store.claimPanel(opts.member.guild.id, opts.member.id, opts.panel.id);
    if (claim) return claim;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 250);
  }
}

async function applyClaimedRoleDelta(
  opts: Parameters<typeof applyRoleDelta>[0],
  claimToken: SelfRoleClaim,
  authoritativeMember: GuildMember,
  panelClaim: SelfRolePanelClaim | null,
): Promise<void> {
  const { panel, member } = opts;
  const reason = `TWO self-role panel ${panel.id}`;
  const heldRoleIds = new Set(authoritativeMember.roles.cache.keys());
  const planned = recomputeDelta(opts, heldRoleIds);
  if (!planned.ok) {
    await auditClaimed(opts, claimToken, 'rejected', planned.code, planned.reason);
    if (opts.reply) await opts.reply.editReply({ content: 'That role control is invalid.' });
    return;
  }
  const effectiveOpts: AuditableChange = {
    ...opts,
    optionKey: planned.optionKey,
    roleId: planned.roleId,
    operation: planned.operation,
    addRoleIds: planned.addRoleIds,
    removeRoleIds: planned.removeRoleIds,
  };

  const roleIds = [...new Set([...panel.options.map((option) => option.roleId), ...planned.addRoleIds, ...planned.removeRoleIds])];
  let roles: Map<string, Role>;
  let channels: SelfRoleChannelPermissions[];
  try {
    const [fetchedRoles, fetchedChannels] = await Promise.all([
      member.guild.roles.fetch(),
      member.guild.channels.fetch(),
    ]);
    roles = new Map();
    for (const roleId of new Set([...roleIds, member.guild.id])) {
      const role = fetchedRoles.get(roleId);
      if (role) roles.set(roleId, role);
    }
    channels = [...fetchedChannels.values()]
      .filter((channel): channel is NonNullable<typeof channel> => !!channel)
      .map((channel) => ({
        id: channel.id,
        name: 'name' in channel ? channel.name : undefined,
        permissionOverwrites: 'permissionOverwrites' in channel
          ? [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
              id: overwrite.id,
              type: overwrite.type,
              allow: overwrite.allow,
              deny: overwrite.deny,
            }))
          : [],
      }));
  } catch (err) {
    await auditClaimed(effectiveOpts, claimToken, 'rejected', 'role_or_channel_fetch_failed', String(err));
    log.error('self_role_role_or_channel_fetch_failed', { panelId: panel.id, memberId: member.id, err: String(err) });
    if (opts.reply) {
      await opts.reply.editReply({ content: 'I could not verify that role. Staff have been notified in the logs.' });
    }
    return;
  }
  const failure = validateSelfRoleDispatch(panel, member, roleIds, roles, channels);
  if (failure) {
    await auditClaimed(effectiveOpts, claimToken, 'rejected', failure.code, failure.reason);
    log.error('self_role_rejected', { panelId: panel.id, memberId: member.id, code: failure.code });
    if (opts.reply) await opts.reply.editReply({ content: failure.publicMessage });
    return;
  }

  if (opts.deps.dryRun) {
    await auditClaimed(effectiveOpts, claimToken, 'rejected', 'dry_run', 'TWO_ONBOARDING_DRY_RUN=1');
    if (opts.reply) await opts.reply.editReply({ content: 'Dry run: no roles were changed.' });
    return;
  }

  const effects = emptyEffects();
  const ownership = startOwnershipGuard(opts, claimToken, panelClaim);
  try {
    try {
      // Remove first for exclusive panels, and only use singular endpoints. The
      // shared fenced panel claim plus force-fetched plan keeps the invariant
      // atomic across bot processes without replacing unrelated role state.
      for (const roleId of planned.removeRoleIds) {
        await ownership.assert();
        effects.attemptedRemovedRoleIds.push(roleId);
        await member.roles.remove(roleId, reason);
        await ownership.assert();
      }
      for (const roleId of planned.addRoleIds) {
        await ownership.assert();
        effects.attemptedAddedRoleIds.push(roleId);
        await member.roles.add(roleId, reason);
        await ownership.assert();
      }
    } catch (err) {
      if (err instanceof StaleSelfRoleClaimError) {
        log.error('self_role_stale_claim_stopped', {
          eventId: opts.eventId,
          panelId: panel.id,
          memberId: member.id,
          generation: claimToken.generation,
        });
        return;
      }
      await ownership.assert();
      const reconciliation = await reconcileToSnapshot(
        member,
        panel,
        new Set(claimToken.preMutationRoleIds),
        reason,
        ownership.assert,
      );
      Object.assign(effects, reconciliation.effects);
      if (reconciliation.finalRoleIds) {
        applyWholeEventEffects(effects, panel, claimToken.preMutationRoleIds, reconciliation.finalRoleIds);
      }
      const unresolved = effects.unresolvedAddedRoleIds.length || effects.unresolvedRemovedRoleIds.length;
      const code = unresolved ? 'discord_rejected_reconcile_failed' : 'discord_rejected';
      const failure = unresolved
        ? `${String(err)}; unresolved added=${effects.unresolvedAddedRoleIds.join(',') || 'none'} removed=${effects.unresolvedRemovedRoleIds.join(',') || 'none'}`
        : String(err);
      await ownership.assert();
      await auditClaimed({ ...effectiveOpts, effects }, claimToken, 'rejected', code, failure);
      log.error('self_role_change_failed', {
        panelId: panel.id,
        memberId: member.id,
        err: String(err),
        effects,
      });
      if (opts.reply) {
        await opts.reply.editReply({ content: 'I could not change that role. Staff have been notified in the logs.' });
      }
      return;
    }

    applyWholeEventEffects(effects, panel, claimToken.preMutationRoleIds, claimToken.desiredRoleIds);
    const outcome =
      effects.addedRoleIds.length && effects.removedRoleIds.length
        ? 'switched'
        : effects.addedRoleIds.length
          ? 'assigned'
          : effects.removedRoleIds.length
            ? 'removed'
            : planned.operation === 'remove'
              ? 'already_absent'
              : 'already_held';
    await auditClaimed({ ...effectiveOpts, effects }, claimToken, outcome, null, null);
    if (opts.reply) {
      await opts.reply.editReply({
        content:
          outcome === 'assigned'
            ? 'Role added.'
            : outcome === 'removed'
              ? 'Role removed.'
              : outcome === 'switched'
                ? panel.color
                  ? 'Color updated.'
                  : 'Role updated.'
                : 'No role changes were needed.',
        components: buildSelfRoleComponents(panel, claimToken.desiredRoleIds),
      });
    }
  } finally {
    ownership.stop();
  }
}

function recomputeDelta(
  opts: Parameters<typeof applyRoleDelta>[0],
  heldRoleIds: ReadonlySet<string>,
):
  | { ok: true; optionKey: string | null; roleId: string | null; operation: 'add' | 'remove' | 'replace'; addRoleIds: string[]; removeRoleIds: string[] }
  | { ok: false; code: string; reason: string } {
  if (opts.desiredRoleIds) {
    const offered = new Set(opts.panel.options.map((option) => option.roleId));
    const desired = new Set(opts.desiredRoleIds);
    if ([...desired].some((roleId) => !offered.has(roleId)) || (opts.panel.exclusive && desired.size > 1)) {
      return { ok: false, code: 'invalid_selection', reason: 'selection contains an unconfigured or non-exclusive role' };
    }
    const current = new Set([...heldRoleIds].filter((roleId) => offered.has(roleId)));
    const addRoleIds = [...desired].filter((roleId) => !current.has(roleId));
    const removeRoleIds = [...current].filter((roleId) => !desired.has(roleId));
    return {
      ok: true,
      optionKey: opts.optionKey,
      roleId: addRoleIds[0] ?? removeRoleIds[0] ?? opts.roleId,
      operation: opts.panel.exclusive || (addRoleIds.length && removeRoleIds.length)
        ? 'replace'
        : addRoleIds.length ? 'add' : 'remove',
      addRoleIds,
      removeRoleIds,
    };
  }

  if (opts.requestedOptionKey) {
    const option = opts.panel.options.find((candidate) => candidate.key === opts.requestedOptionKey);
    const remove = opts.requestedToggle && option
      ? heldRoleIds.has(option.roleId)
      : !!opts.requestedRemove;
    const plan = planSelfRoleChange({
      panel: opts.panel,
      optionKey: opts.requestedOptionKey,
      memberRoleIds: [...heldRoleIds],
      source: opts.source,
      remove,
    });
    if (!plan.ok) return plan;
    return {
      ok: true,
      optionKey: plan.option.key,
      roleId: plan.option.roleId,
      operation: plan.operation,
      addRoleIds: plan.addRoleIds,
      removeRoleIds: plan.removeRoleIds,
    };
  }

  return {
    ok: true,
    optionKey: opts.optionKey,
    roleId: opts.roleId,
    operation: opts.operation,
    addRoleIds: opts.addRoleIds.filter((roleId) => !heldRoleIds.has(roleId)),
    removeRoleIds: opts.removeRoleIds.filter((roleId) => heldRoleIds.has(roleId)),
  };
}

async function reconcileToSnapshot(
  member: GuildMember,
  panel: SelfRolePanel,
  before: ReadonlySet<string>,
  reason: string,
  assertOwnership: () => Promise<void>,
): Promise<{
  effects: Pick<MutationEffects,
    'compensatedAddedRoleIds' | 'compensatedRemovedRoleIds' | 'unresolvedAddedRoleIds' | 'unresolvedRemovedRoleIds'>;
  finalRoleIds: Iterable<string> | null;
}> {
  const panelRoleIds = panel.options.map((option) => option.roleId);
  const compensatedAddedRoleIds: string[] = [];
  const compensatedRemovedRoleIds: string[] = [];
  let current: GuildMember;
  await assertOwnership();
  try {
    current = await member.guild.members.fetch({ user: member.id, force: true });
    await assertOwnership();
  } catch (err) {
    if (err instanceof StaleSelfRoleClaimError) throw err;
    return {
      effects: {
        compensatedAddedRoleIds,
        compensatedRemovedRoleIds,
        unresolvedAddedRoleIds: panelRoleIds.filter((roleId) => !before.has(roleId)),
        unresolvedRemovedRoleIds: panelRoleIds.filter((roleId) => before.has(roleId)),
      },
      finalRoleIds: null,
    };
  }

  for (const roleId of panelRoleIds) {
    const had = before.has(roleId);
    const has = current.roles.cache.has(roleId);
    if (had === has) continue;
    try {
      await assertOwnership();
      if (had) {
        await member.roles.add(roleId, `${reason} reconcile`);
        await assertOwnership();
        compensatedAddedRoleIds.push(roleId);
      } else {
        await member.roles.remove(roleId, `${reason} reconcile`);
        await assertOwnership();
        compensatedRemovedRoleIds.push(roleId);
      }
    } catch (err) {
      if (err instanceof StaleSelfRoleClaimError) throw err;
      // The final authoritative fetch below records what remains unresolved.
    }
  }

  await assertOwnership();
  try {
    current = await member.guild.members.fetch({ user: member.id, force: true });
    await assertOwnership();
  } catch (err) {
    if (err instanceof StaleSelfRoleClaimError) throw err;
    return {
      effects: {
        compensatedAddedRoleIds,
        compensatedRemovedRoleIds,
        unresolvedAddedRoleIds: panelRoleIds.filter((roleId) => !before.has(roleId)),
        unresolvedRemovedRoleIds: panelRoleIds.filter((roleId) => before.has(roleId)),
      },
      finalRoleIds: null,
    };
  }
  return {
    effects: {
      compensatedAddedRoleIds,
      compensatedRemovedRoleIds,
      unresolvedAddedRoleIds: panelRoleIds.filter((roleId) => !before.has(roleId) && current.roles.cache.has(roleId)),
      unresolvedRemovedRoleIds: panelRoleIds.filter((roleId) => before.has(roleId) && !current.roles.cache.has(roleId)),
    },
    finalRoleIds: current.roles.cache.keys(),
  };
}

function applyWholeEventEffects(
  effects: MutationEffects,
  panel: SelfRolePanel,
  beforeRoleIds: Iterable<string>,
  finalRoleIds: Iterable<string>,
): void {
  const offered = new Set(panel.options.map((option) => option.roleId));
  const before = new Set([...beforeRoleIds].filter((roleId) => offered.has(roleId)));
  const final = new Set([...finalRoleIds].filter((roleId) => offered.has(roleId)));
  effects.addedRoleIds = [...final].filter((roleId) => !before.has(roleId));
  effects.removedRoleIds = [...before].filter((roleId) => !final.has(roleId));
}

class StaleSelfRoleClaimError extends Error {}

function startOwnershipGuard(
  opts: Parameters<typeof applyRoleDelta>[0],
  eventClaim: SelfRoleClaim,
  panelClaim: SelfRolePanelClaim | null,
): { assert: () => Promise<void>; stop: () => void } {
  let stale = false;
  let stopped = false;
  let renewing: Promise<void> | null = null;
  const renewAfterMs = Math.max(1, Math.min(
    eventClaim.renewAfterMs ?? 60_000,
    panelClaim?.renewAfterMs ?? Number.MAX_SAFE_INTEGER,
  ));

  const owns = async (): Promise<boolean> => {
    const checks = [opts.deps.store.ownsClaim?.(opts.eventId, eventClaim) ?? true];
    if (panelClaim) checks.push(opts.deps.store.ownsPanelClaim?.(panelClaim) ?? true);
    return (await Promise.all(checks)).every(Boolean);
  };
  const renew = async (): Promise<void> => {
    if (stopped || stale) return;
    if (opts.deps.store.renewClaim && !await opts.deps.store.renewClaim(opts.eventId, eventClaim)) stale = true;
    if (!stale && panelClaim && opts.deps.store.renewPanelClaim && !await opts.deps.store.renewPanelClaim(panelClaim)) stale = true;
  };
  const schedule = (): void => {
    const timer = setTimeout(() => {
      renewing = renew().finally(() => {
        renewing = null;
        if (!stopped && !stale) schedule();
      });
    }, renewAfterMs);
    timer.unref?.();
    stopTimer = () => clearTimeout(timer);
  };
  let stopTimer = () => {};
  schedule();

  return {
    assert: async () => {
      if (renewing) await renewing;
      if (stale || !await owns()) {
        stale = true;
        throw new StaleSelfRoleClaimError('self-role claim was superseded');
      }
    },
    stop: () => {
      stopped = true;
      stopTimer();
    },
  };
}

async function withPanelMemberLock<T>(guildId: string, memberId: string, panelId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${guildId}:${memberId}:${panelId}`;
  const previous = panelMemberLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  panelMemberLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (panelMemberLocks.get(key) === tail) panelMemberLocks.delete(key);
  }
}

export function validateSelfRoleDispatch(
  panel: SelfRolePanel,
  member: GuildMember,
  roleIds: readonly string[],
  roles: ReadonlyMap<string, Role> = member.guild.roles.cache,
  channels: readonly SelfRoleChannelPermissions[] = [],
): { code: string; reason: string; publicMessage: string } | null {
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return {
      code: 'missing_manage_roles',
      reason: 'bot member does not have Manage Roles',
      publicMessage: 'I cannot manage roles in this server. Staff have been notified in the logs.',
    };
  }
  for (const roleId of new Set(roleIds)) {
    const role = roles.get(roleId);
    if (!role) {
      return { code: 'missing_role', reason: `role ${roleId} is not in the guild cache`, publicMessage: 'That role no longer exists.' };
    }
    const disallowed = findSelfRoleDisallowedPermission(role.permissions);
    if (disallowed) {
      return {
        code: 'disallowed_role_permission',
        reason: `role ${roleId} has disallowed permission ${disallowed}`,
        publicMessage: 'That role is not safe for self-service. Staff have been notified in the logs.',
      };
    }
    const everyone = roles.get(member.guild.id);
    if (channels.length && !everyone) {
      return {
        code: 'missing_everyone_role',
        reason: `guild @everyone role ${member.guild.id} was not fetched`,
        publicMessage: 'I could not verify that role. Staff have been notified in the logs.',
      };
    }
    const unsafeGrant = everyone
      ? findSelfRoleUnsafeChannelGrant({
          guildId: member.guild.id,
          roleId,
          everyonePermissions: everyone.permissions,
          rolePermissions: role.permissions,
          channels,
        })
      : null;
    if (unsafeGrant) {
      return {
        code: 'disallowed_channel_permission',
        reason: `role ${roleId} has disallowed effective channel permission ${unsafeGrant.permission} in channel ${unsafeGrant.channelId}`,
        publicMessage: 'That role is not safe for self-service. Staff have been notified in the logs.',
      };
    }
    const option = panel.options.find((candidate) => candidate.roleId === roleId);
    if (!option || role.permissions.bitfield !== BigInt(option.permissions)) {
      return {
        code: 'role_permissions_changed',
        reason: option
          ? `role ${roleId} permission mask changed from ${option.permissions} to ${role.permissions.bitfield}`
          : `role ${roleId} is not configured on panel ${panel.id}`,
        publicMessage: 'That role changed after this panel was configured. Staff have been notified in the logs.',
      };
    }
    if (role.managed || !role.editable) {
      return {
        code: 'role_hierarchy',
        reason: `role ${roleId} is managed or not below the bot`,
        publicMessage: 'I cannot manage that role because the role hierarchy is wrong.',
      };
    }
  }
  return null;
}

async function rejectComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  panel: SelfRolePanel,
  deps: SelfRoleDeps,
  code: string,
  publicMessage: string,
): Promise<void> {
  const row: SelfRoleAuditRow = {
    eventId: interaction.id,
    guildId: interaction.guildId!,
    panelId: panel.id,
    memberId: interaction.user.id,
    sourceId: interaction.message.id,
    optionKey: null,
    roleId: null,
    source: interaction.isButton() ? 'button' : 'select',
    operation: 'add',
    outcome: 'rejected',
    code,
    reason: publicMessage,
    ...emptyEffects(),
  };
  const claimed = await deps.store.claimAudit(row);
  if (claimed) await deps.store.finishAudit(row, claimed);
  await interaction.editReply({ content: publicMessage });
}

type MutationEffects = Pick<SelfRoleAuditRow,
  | 'addedRoleIds'
  | 'removedRoleIds'
  | 'attemptedAddedRoleIds'
  | 'attemptedRemovedRoleIds'
  | 'compensatedAddedRoleIds'
  | 'compensatedRemovedRoleIds'
  | 'unresolvedAddedRoleIds'
  | 'unresolvedRemovedRoleIds'>;

type AuditableChange = {
  panel: SelfRolePanel;
  member: GuildMember;
  source: SelfRolePanelMode;
  sourceId: string;
  eventId: string;
  optionKey: string | null;
  roleId: string | null;
  operation: 'add' | 'remove' | 'replace';
  addRoleIds: string[];
  removeRoleIds: string[];
  deps: SelfRoleDeps;
  effects?: MutationEffects;
};

function emptyEffects(): MutationEffects {
  return {
    addedRoleIds: [],
    removedRoleIds: [],
    attemptedAddedRoleIds: [],
    attemptedRemovedRoleIds: [],
    compensatedAddedRoleIds: [],
    compensatedRemovedRoleIds: [],
    unresolvedAddedRoleIds: [],
    unresolvedRemovedRoleIds: [],
  };
}

function auditRow(
  opts: AuditableChange,
  outcome: SelfRoleAuditRow['outcome'],
  code: string | null,
  reason: string | null,
): SelfRoleAuditRow {
  return {
    eventId: opts.eventId,
    guildId: opts.member.guild.id,
    panelId: opts.panel.id,
    memberId: opts.member.id,
    sourceId: opts.sourceId,
    optionKey: opts.optionKey,
    roleId: opts.roleId,
    source: opts.source,
    operation: opts.operation,
    outcome,
    code,
    reason,
    ...(opts.effects ?? emptyEffects()),
  };
}

async function claim(opts: AuditableChange & { desiredRoleIds?: string[]; preMutationRoleIds?: string[] }): Promise<SelfRoleClaim | null> {
  return opts.deps.store.claimAudit({
    ...auditRow(opts, 'processing', null, null),
    desiredRoleIds: opts.desiredRoleIds,
    preMutationRoleIds: opts.preMutationRoleIds,
  });
}

async function auditRejected(opts: Parameters<typeof applyRoleDelta>[0], code: string, reason: string): Promise<void> {
  const row = auditRow(opts, 'rejected', code, reason);
  const claimed = await opts.deps.store.claimAudit(row);
  if (claimed) await opts.deps.store.finishAudit(row, claimed);
}

async function auditClaimed(
  opts: AuditableChange,
  claim: SelfRoleClaim,
  outcome: Exclude<SelfRoleAuditRow['outcome'], 'processing'>,
  code: string | null,
  reason: string | null,
): Promise<void> {
  await opts.deps.store.finishAudit(auditRow(opts, outcome, code, reason), claim);
}

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
  type StringSelectMenuInteraction,
  type User,
} from 'discord.js';
import { log } from '../core/log.ts';
import { parseSelfRoleCustomId, planSelfRoleChange, reactionOptionKey, selfRoleCustomId } from '../selfRoles/plan.ts';
import type { SelfRolePanel, SelfRolePanelMode } from '../selfRoles/types.ts';
import type { SelfRoleStore } from '../store/selfRoleStore.ts';

export interface SelfRoleDeps {
  panels: SelfRolePanel[];
  store: SelfRoleStore;
  dryRun?: boolean;
}

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
    await handleComponent(interaction, panel, parsed.optionKey, deps);
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
      member = await guild.members.fetch(user.id);
    } catch (err) {
      log.error('self_role_member_fetch_failed', { panelId: panel.id, memberId: user.id, err: String(err) });
      return;
    }
    // Discord reaction events have no delivery id. Use a fresh audit id and let
    // the idempotent role plan make duplicate gateway deliveries no-ops.
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

  client.on(Events.MessageReactionAdd, (reaction, user) => void onReaction(reaction, user, false));
  client.on(Events.MessageReactionRemove, (reaction, user) => void onReaction(reaction, user, true));
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
    const option = panel.options.find((o) => o.key === optionKey);
    const remove = !!option && member.roles.cache.has(option.roleId);
    await applyChange({
      panel,
      member,
      optionKey,
      source: 'button',
      sourceId: interaction.message.id,
      eventId: interaction.id,
      remove,
      deps,
      reply: interaction,
    });
    return;
  }

  const selected = new Set(interaction.values);
  const unknown = [...selected].filter((key) => !panel.options.some((o) => o.key === key));
  if (unknown.length || (panel.exclusive && selected.size > 1)) {
    await rejectComponent(interaction, panel, deps, 'invalid_selection', 'That role selection is invalid.');
    return;
  }

  const currentKeys = panel.options.filter((o) => member.roles.cache.has(o.roleId)).map((o) => o.key);
  const removeKeys = currentKeys.filter((key) => !selected.has(key));
  const addKeys = [...selected].filter((key) => !currentKeys.includes(key));
  if (removeKeys.length === 0 && addKeys.length === 0) {
    await interaction.editReply({ content: 'No role changes were needed.', components: buildSelfRoleComponents(panel, [...member.roles.cache.keys()]) });
    return;
  }

  const removeRoleIds = removeKeys.map((key) => panel.options.find((o) => o.key === key)!.roleId);
  const addRoleIds = addKeys.map((key) => panel.options.find((o) => o.key === key)!.roleId);
  await applyRoleDelta({
    panel,
    member,
    source: 'select',
    sourceId: interaction.message.id,
    eventId: interaction.id,
    optionKey: addKeys[0] ?? removeKeys[0] ?? null,
    roleId: addRoleIds[0] ?? removeRoleIds[0] ?? null,
    operation: panel.exclusive ? 'replace' : addRoleIds.length && removeRoleIds.length ? 'replace' : addRoleIds.length ? 'add' : 'remove',
    addRoleIds,
    removeRoleIds,
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
  deps: SelfRoleDeps;
  reply?: ButtonInteraction | StringSelectMenuInteraction;
}): Promise<void> {
  const plan = planSelfRoleChange({
    panel: opts.panel,
    optionKey: opts.optionKey,
    memberRoleIds: [...opts.member.roles.cache.keys()],
    source: opts.source,
    remove: opts.remove,
  });
  if (!plan.ok) {
    if (opts.reply) await rejectComponent(opts.reply, opts.panel, opts.deps, plan.code, 'That role control is invalid.');
    return;
  }
  await applyRoleDelta({
    ...opts,
    optionKey: plan.option.key,
    roleId: plan.option.roleId,
    operation: plan.operation,
    addRoleIds: plan.addRoleIds,
    removeRoleIds: plan.removeRoleIds,
  });
}

async function applyRoleDelta(opts: {
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
  reply?: ButtonInteraction | StringSelectMenuInteraction;
}): Promise<void> {
  const { panel, member } = opts;
  const claimed = await claim(opts);
  if (!claimed) {
    if (opts.reply) await opts.reply.editReply({ content: 'This role request was already handled.' });
    return;
  }

  const reason = `TWO self-role panel ${panel.id}`;
  const failure = validateRoles(member, [...opts.addRoleIds, ...opts.removeRoleIds]);
  if (failure) {
    await audit(opts, 'rejected', failure.code, failure.reason);
    log.error('self_role_rejected', { panelId: panel.id, memberId: member.id, code: failure.code });
    if (opts.reply) await opts.reply.editReply({ content: failure.publicMessage });
    return;
  }

  if (opts.deps.dryRun) {
    await audit(opts, 'rejected', 'dry_run', 'TWO_ONBOARDING_DRY_RUN=1');
    if (opts.reply) await opts.reply.editReply({ content: 'Dry run: no roles were changed.' });
    return;
  }

  try {
    // Remove first for exclusive/color panels: Discord never sees the member
    // holding two mutually-exclusive color roles after a successful operation.
    if (opts.removeRoleIds.length) await member.roles.remove(opts.removeRoleIds, reason);
    if (opts.addRoleIds.length) await member.roles.add(opts.addRoleIds, reason);
  } catch (err) {
    await audit(opts, 'rejected', 'discord_rejected', String(err));
    log.error('self_role_change_failed', { panelId: panel.id, memberId: member.id, err: String(err) });
    if (opts.reply) {
      await opts.reply.editReply({ content: 'I could not change that role. Staff have been notified in the logs.' });
    }
    return;
  }

  const outcome =
    opts.addRoleIds.length && opts.removeRoleIds.length
      ? 'switched'
      : opts.addRoleIds.length
        ? 'assigned'
        : opts.removeRoleIds.length
          ? 'removed'
          : opts.operation === 'remove'
            ? 'already_absent'
            : 'already_held';
  await audit(opts, outcome, null, null);
  if (opts.reply) {
    const final = new Set(member.roles.cache.keys());
    for (const roleId of opts.removeRoleIds) final.delete(roleId);
    for (const roleId of opts.addRoleIds) final.add(roleId);
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
      components: buildSelfRoleComponents(panel, [...final]),
    });
  }
}

function validateRoles(
  member: GuildMember,
  roleIds: readonly string[],
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
    const role = member.guild.roles.cache.get(roleId);
    if (!role) {
      return { code: 'missing_role', reason: `role ${roleId} is not in the guild cache`, publicMessage: 'That role no longer exists.' };
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
  const row = {
    eventId: interaction.id,
    guildId: interaction.guildId!,
    panelId: panel.id,
    memberId: interaction.user.id,
    sourceId: interaction.message.id,
    optionKey: null,
    roleId: null,
    source: interaction.isButton() ? ('button' as const) : ('select' as const),
    operation: 'add' as const,
    outcome: 'rejected' as const,
    code,
    reason: publicMessage,
    addedRoleIds: [],
    removedRoleIds: [],
  };
  if (await deps.store.claimAudit(row)) await deps.store.finishAudit(row);
  await interaction.editReply({ content: publicMessage });
}

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
};

function auditRow(
  opts: AuditableChange,
  outcome: 'processing' | 'assigned' | 'removed' | 'switched' | 'already_held' | 'already_absent' | 'rejected',
  code: string | null,
  reason: string | null,
) {
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
    addedRoleIds: opts.addRoleIds,
    removedRoleIds: opts.removeRoleIds,
  };
}

async function claim(opts: AuditableChange): Promise<boolean> {
  return opts.deps.store.claimAudit(auditRow(opts, 'processing', null, null));
}

async function audit(
  opts: AuditableChange,
  outcome: 'assigned' | 'removed' | 'switched' | 'already_held' | 'already_absent' | 'rejected',
  code: string | null,
  reason: string | null,
): Promise<void> {
  await opts.deps.store.finishAudit(auditRow(opts, outcome, code, reason));
}

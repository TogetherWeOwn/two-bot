/**
 * The discord.js side of the onboarding flow.
 *
 * Everything member-facing that TWO-7 ships lives here:
 *   join (rules accepted) -> welcome post in the landing channel
 *   -> game picker -> roles granted -> links to channels they can now open.
 *
 * Two hard rules, both from the issue and both enforced in code rather than by
 * intention:
 *
 *   NO DMs. Nothing in this file calls `.send()` on a User. The only outbound
 *   paths are a post in the configured landing channel and ephemeral interaction
 *   replies, which are visible to one person and are never a mass message.
 *
 *   NO LINKS TO DARK CHANNELS. Before we put a channel in front of someone we
 *   ask Discord whether that member can actually view it. A link to a channel
 *   they cannot open is worse than no link.
 */

import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { log } from '../core/log.ts';
import type { DiscordOnboardingRota } from './onboardingRota.ts';
import {
  OnboardingRecorder,
  currentGameKeys,
  planSelection,
} from '../onboarding/flow.ts';
import { GAME_PICKS, INTRO_CHANNEL_ID, type GamePick } from '../onboarding/catalog.ts';

/**
 * Custom id for the picker. Static on purpose: the panel posted in a channel
 * outlives every bot restart, so the id cannot encode a session or a member.
 * We take the member from the interaction instead, which Discord signs for us.
 */
export const GAME_SELECT_ID = 'two:onboarding:games';

export interface OnboardingDeps {
  recorder: OnboardingRecorder;
  /**
   * Channels the welcome post may go to. First one the bot can post in wins.
   * A thunk rather than a plain array so a settings-store reload (TOG-3536)
   * is visible to the next member without a restart.
   */
  landingChannelIds: () => string[];
  /** When true, assign no roles and post nothing. Used by preflight. */
  dryRun?: boolean;
  onboardingRota?: Pick<DiscordOnboardingRota, 'promptShown'>;
}

// --- picker construction ----------------------------------------------------

export function buildGameSelect(selected: readonly string[] = []): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(GAME_SELECT_ID)
    .setPlaceholder('What do you play?')
    .setMinValues(0)
    .setMaxValues(GAME_PICKS.length)
    .addOptions(
      GAME_PICKS.map((p) => {
        const opt = new StringSelectMenuOptionBuilder()
          .setLabel(p.label)
          .setValue(p.key)
          .setEmoji(p.emoji)
          .setDefault(selected.includes(p.key));
        if (p.description) opt.setDescription(p.description);
        return opt;
      }),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * The welcome text. Deliberately plain and short.
 *
 * Tone and brand are the CEO's call, not mine - this is a placeholder that
 * says the necessary thing in as few words as possible, and it is the one
 * string in this file anyone should feel free to rewrite without touching
 * logic. See docs/ROUTING.md.
 */
export function welcomeText(memberMention: string): string {
  return [
    `${memberMention} welcome to TWO.`,
    '',
    'Pick what you play below and I will open the right channels for you.',
    `You can change this any time, and there is an intro thread in <#${INTRO_CHANNEL_ID}> if you want one.`,
  ].join('\n');
}

// --- helpers ----------------------------------------------------------------

/** Can this specific member open this specific channel, right now? */
function memberCanView(member: GuildMember, channelId: string): boolean {
  const ch = member.guild.channels.cache.get(channelId);
  if (!ch) return false;
  const perms = ch.permissionsFor(member);
  return !!perms?.has(PermissionsBitField.Flags.ViewChannel);
}

/**
 * Can the bot post in here? Checked before we pick a landing channel.
 *
 * `isTextBased()` already excludes forums, which cannot take a direct message
 * and would otherwise look like a valid target.
 */
function botCanPost(client: Client, channelId: string): GuildTextBasedChannel | null {
  const ch = client.channels.cache.get(channelId);
  if (!ch || !ch.isTextBased() || ch.isDMBased()) return null;
  const me = ch.guild.members.me;
  if (!me) return null;
  const perms = ch.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) return null;
  if (!perms.has(PermissionsBitField.Flags.SendMessages)) return null;
  return ch;
}

function channelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

// --- wiring -----------------------------------------------------------------

export function registerOnboarding(client: Client, deps: OnboardingDeps): void {
  const { recorder } = deps;

  /** Post the welcome + picker for a member who has cleared the rules gate. */
  async function promptMember(member: GuildMember): Promise<void> {
    const decision = await recorder.shouldPrompt({
      guildId: member.guild.id,
      memberId: member.id,
      isBot: !!member.user?.bot,
      pending: !!member.pending,
    });
    if (!decision.shouldPrompt) {
      log.debug('onboarding_skip', { memberId: member.id, reason: decision.reason });
      return;
    }

    const landingChannelIds = deps.landingChannelIds();
    const target = landingChannelIds.map((id) => botCanPost(client, id)).find(Boolean);
    if (!target) {
      // Loud, because it means every new member is silently getting nothing.
      log.error('onboarding_no_landing_channel', { tried: landingChannelIds });
      return;
    }

    if (deps.dryRun) {
      log.info('onboarding_dry_run', { memberId: member.id, channelId: target.id });
      return;
    }

    try {
      const message = await target.send({
        content: welcomeText(`<@${member.id}>`),
        components: [buildGameSelect()],
        allowedMentions: { users: [member.id] },
      });
      void deps.onboardingRota?.promptShown({
        member, message, variant: 'legacy', actionChannelId: INTRO_CHANNEL_ID,
      });
      await recorder.prompted(member.guild.id, member.id, target.id);
    } catch (err) {
      log.error('onboarding_prompt_failed', { memberId: member.id, err: String(err) });
    }
  }

  // A member who joins with the gate already cleared (rare on TWO, but real
  // for people who accepted rules on the invite screen).
  client.on(Events.GuildMemberAdd, (member) => {
    if (member.pending) return; // GuildMemberUpdate will pick them up
    void promptMember(member);
  });

  // The normal path on TWO: pending flips true -> false when they accept the
  // rules. That is the first moment they can actually click anything.
  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (oldMember.pending && !newMember.pending) void promptMember(newMember);
  });

  registerGameSelect(client, deps);
}

/**
 * Just the picker's interaction handler, without the welcome post.
 *
 * Split out for TOG-93: when the routed welcome owns the rules-gate-clear
 * moment, the picker must keep working - the panel posted in a channel outlives
 * any one welcome, and roles are how "what does this community play" is
 * answered - but it must not also post a second greeting.
 */
export function registerGameSelect(client: Client, deps: OnboardingDeps): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== GAME_SELECT_ID) return;
    await handleGameSelect(interaction as StringSelectMenuInteraction, deps);
  });
}

export async function handleGameSelect(
  interaction: StringSelectMenuInteraction,
  deps: OnboardingDeps,
): Promise<void> {
  const { recorder } = deps;
  const member = interaction.member as GuildMember | null;
  const guild = interaction.guild;
  if (!member || !guild) return;

  // Ephemeral: only the person who clicked sees the result. Keeps the landing
  // channel readable and means the picker is not a broadcast.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const plan = planSelection(interaction.values, (id) => memberCanView(member, id));
  if (plan.unknownKeys.length) {
    log.error('picker_unknown_keys', { keys: plan.unknownKeys });
  }

  if (deps.dryRun) {
    await interaction.editReply({ content: 'Dry run: no roles were changed.' });
    return;
  }

  // The menu shows every game pick, so what it returns is the member's whole
  // answer - not a delta. Unticking a game has to actually remove that role,
  // otherwise the roles drift away from what people told us and the "what does
  // this community play" numbers slowly become fiction.
  const selectedRoleIds = new Set(plan.roleIds);
  const toRemove = GAME_PICKS.filter(
    (p) => !selectedRoleIds.has(p.roleId) && member.roles.cache.has(p.roleId),
  ).map((p) => p.roleId);

  try {
    if (plan.roleIds.length) {
      await member.roles.add(plan.roleIds, 'TWO onboarding: member self-selected games');
    }
    if (toRemove.length) {
      await member.roles.remove(toRemove, 'TWO onboarding: member deselected games');
    }
  } catch (err) {
    // Almost always role hierarchy: someone moved the bot's role below a game
    // role. Say something useful rather than failing silently.
    log.error('picker_role_change_failed', { memberId: member.id, err: String(err) });
    await interaction.editReply({
      content:
        'I could not set those roles - my own permissions are wrong. Staff have been notified in the logs.',
    });
    return;
  }

  if (plan.roleIds.length === 0) {
    await interaction.editReply({
      content: 'Cleared your game roles. Open the menu again whenever you like.',
      components: [buildGameSelect([])],
    });
    return;
  }

  await recorder.selected(guild.id, member.id, plan);

  // Re-resolve after granting: a role we just added can itself reveal the
  // channel we want to link, so the "before" answer would be wrong.
  const finalPlan = planSelection(interaction.values, (id) => memberCanView(member, id));
  const lines = finalPlan.destinations
    .map((d) => d.channelId === null
      ? `${d.pick.emoji} **${d.pick.label}** → No channel is available to you right now.`
      : `${d.pick.emoji} **${d.pick.label}** → ${channelLink(guild.id, d.channelId)}`)
    .filter((v, i, a) => a.indexOf(v) === i);

  if (finalPlan.channelIds.length) {
    await recorder.routed(guild.id, member.id, finalPlan);
    const seconds = await recorder.timeToRouteSeconds(guild.id, member.id);
    if (seconds !== null) log.info('time_to_route', { memberId: member.id, seconds });
  }

  await interaction.editReply({
    content: [finalPlan.channelIds.length ? 'Done. Here is where to go:' : 'Game roles saved.', '', ...lines].join('\n'),
    // Ticked with what they now hold, so "change it any time" is one click and
    // not a re-declaration of everything.
    components: [buildGameSelect(currentGameKeys([...member.roles.cache.keys()]))],
  });
}

/** Exported for the picker panel script. */
export function pickLabel(p: GamePick): string {
  return `${p.emoji} ${p.label}`;
}

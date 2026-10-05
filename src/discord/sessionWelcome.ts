/**
 * The discord.js side of session routing (TOG-1644 / TOG-1654).
 *
 *   join (rules accepted) -> welcome post + "what do you want to do" picker
 *   -> selection -> ephemeral ack linking the destination
 *   -> leave -> goodbye post
 *
 * Three hard rules, all from the accepted decision:
 *
 *   NO ROLES. Nothing in this file calls member.roles.add or .remove, and no
 *   role id appears in it. The zero-role-delta guarantee is structural, not
 *   behavioural - there is no code path that could grant one.
 *
 *   NO DMs. Outbound paths are the welcome post in the landing channel, the
 *   goodbye post in the goodbye channel, and ephemeral interaction replies.
 *
 *   NO LINKS TO DARK CHANNELS. Every destination is checked against Discord's
 *   own permission answer for *that member* before it is put in front of them.
 *
 * The legacy role picker (src/discord/onboarding.ts) stays untouched; this
 * module is selected by TWO_ONBOARDING_MODE=session in src/index.ts.
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
} from 'discord.js';
import { log } from '../core/log.ts';
import type { DiscordOnboardingRota } from './onboardingRota.ts';
import { EventStore } from '../store/eventStore.ts';
import {
  SESSION_SELECT_ID,
  SessionRecorder,
  type SessionPick,
  daysInGuild,
  goodbyeText,
  planSession,
  sessionAckText,
  sessionWelcomeText,
} from '../onboarding/session.ts';

export interface SessionWelcomeDeps {
  recorder: SessionRecorder;
  store: EventStore;
  /** Session mode is intentionally restricted to exactly one guild. */
  guildId: string;
  /**
   * Welcome goes to the first of these the bot can post in. A thunk rather
   * than a plain array so a settings-store reload (TOG-3536) is visible to
   * the next member without a restart.
   */
  landingChannelIds: () => string[];
  /** Where goodbyes go. Same rule: first postable channel wins. A thunk rather
   * than a plain array so a settings-store reload (TOG-3314, following TOG-3536's
   * landing-channel wire) is visible to the next leave without a restart. */
  goodbyeChannelIds: () => string[];
  /** Per-guild picker destinations; channel ids must never be shared across guilds. */
  picks: SessionPick[];
  /**
   * True = keep role-writing features disabled; session welcomes still post
   * because they never write roles.
   */
  dryRun?: boolean;
  onboardingRota?: Pick<DiscordOnboardingRota, 'promptShown'>;
}

export function buildSessionMenu(picks: SessionPick[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SESSION_SELECT_ID)
    .setPlaceholder('What do you want to do right now?')
    .setMinValues(1)
    .setMaxValues(picks.length)
    .addOptions(
      picks.map((p) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(p.label)
          .setValue(p.key)
          .setEmoji(p.emoji)
          .setDescription(p.description),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** Can this specific member open this specific channel, right now? */
function memberCanView(member: GuildMember, channelId: string): boolean {
  const ch = member.guild.channels.cache.get(channelId);
  if (!ch) return false;
  const perms = ch.permissionsFor(member);
  return !!perms?.has(PermissionsBitField.Flags.ViewChannel);
}

function botCanPost(client: Client, channelId: string, guildId: string): GuildTextBasedChannel | null {
  const ch = client.channels.cache.get(channelId);
  if (!ch || !ch.isTextBased() || ch.isDMBased() || ch.guild.id !== guildId) return null;
  const botId = client.user?.id;
  if (!botId) return null;
  const perms = ch.permissionsFor(botId);
  if (!perms?.has(PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages)) {
    return null;
  }
  return ch as GuildTextBasedChannel;
}

export function registerSessionWelcome(client: Client, deps: SessionWelcomeDeps): void {
  const { recorder } = deps;
  const prompting = new Map<string, Promise<void>>();
  // Delivery is in-memory and separate from persistence: once target.send
  // resolves, the public welcome is out even if the prompted-event write
  // below rejects. Queued callbacks must recover recording without resending.
  const delivered = new Map<string, string>();

  async function promptMember(member: GuildMember): Promise<void> {
    if (member.guild.id !== deps.guildId) return;
    if (member.user.bot) return;
    // Queue before the first await, and hold through recording. Overlapping
    // callbacks recheck persistence after the active attempt, even if it fails.
    const previous = prompting.get(member.id);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    prompting.set(member.id, current);

    try {
      await previous;
      // Idempotency half one: a member who has already been welcomed is not
      // welcomed again, no matter how many times pending flips.
      if (await deps.store.hasEvent(member.guild.id, member.id, 'onboarding_prompted')) return;

      const deliveredChannelId = delivered.get(member.id);
      if (deliveredChannelId) {
        // The welcome already went out in this process; the earlier attempt
        // only failed to persist it. Retry recording without a second send.
        await recorder.prompted(member.guild.id, member.id, deliveredChannelId);
        return;
      }

      const landingChannelIds = deps.landingChannelIds();
      const target =
        landingChannelIds.map((id) => botCanPost(client, id, deps.guildId)).find(Boolean) ?? null;
      if (!target) {
        log.error('session_welcome_no_channel', {
          tried: landingChannelIds,
          memberId: member.id,
        });
        return;
      }

      if (deps.dryRun) {
        log.info('session_welcome_dry_run', { memberId: member.id, channelId: target.id });
      }

      const message = await target.send({
        content: sessionWelcomeText(`<@${member.id}>`),
        components: [buildSessionMenu(deps.picks)],
        allowedMentions: { users: [member.id] },
      });
      const actionChannelId = deps.picks.find((pick) => pick.key === 'find-players')?.channelId;
      if (actionChannelId) {
        void deps.onboardingRota?.promptShown({ member, message, variant: 'session', actionChannelId });
      }
      // Mark delivery before persisting: a recording failure below must not
      // cause a queued callback to send a second public welcome.
      delivered.set(member.id, target.id);
      await recorder.prompted(member.guild.id, member.id, target.id);
    } catch (err) {
      log.error('session_welcome_failed', { memberId: member.id, err: String(err) });
    } finally {
      release();
      if (prompting.get(member.id) === current) prompting.delete(member.id);
    }
  }

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.pending) return; // GuildMemberUpdate picks them up
    void promptMember(member);
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (oldMember.pending && !newMember.pending) void promptMember(newMember);
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== deps.guildId) return;
    // The funnel row is recorded by the core handlers; this is the
    // human-visible half. Joined-at survives on the member object Discord
    // hands us even as they leave.
    const goodbyeChannelIds = deps.goodbyeChannelIds();
    const target =
      goodbyeChannelIds.map((id) => botCanPost(client, id, deps.guildId)).find(Boolean) ?? null;
    if (!target) return;
    if (deps.dryRun) {
      log.info('session_goodbye_dry_run', { memberId: member.id });
      return;
    }
    try {
      await target.send({
        content: goodbyeText(
          member.user?.username ?? member.displayName ?? member.id,
          daysInGuild(member.joinedAt?.toISOString() ?? null, new Date().toISOString()),
        ),
        allowedMentions: { parse: [] }, // never ping the person who left
      });
      log.info('session_goodbye_posted', { memberId: member.id, channelId: target.id });
    } catch (err) {
      log.error('session_goodbye_failed', { memberId: member.id, err: String(err) });
    }
  });

  registerSessionSelect(client, deps);
}

/** The picker handler alone - the panel outlives any single welcome. */
export function registerSessionSelect(client: Client, deps: SessionWelcomeDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== SESSION_SELECT_ID) return;
    await handleSessionSelect(interaction, deps);
  });
}

export async function handleSessionSelect(interaction: unknown, deps: SessionWelcomeDeps): Promise<void> {
  // Typed loosely so the mock harness and tests can drive it without a full
  // discord.js interaction object; the real path always arrives via
  // InteractionCreate.
  const i = interaction as {
    member: GuildMember | null;
    guild: { id: string } | null;
    values: string[];
    deferReply(o: { flags: number }): Promise<unknown>;
    editReply(o: { content: string }): Promise<unknown>;
  };
  const member = i.member;
  if (!member || !i.guild || i.guild.id !== deps.guildId || member.guild.id !== deps.guildId) return;

  // Ephemeral: only the clicker sees the result.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const plan = planSession(i.values, (id) => memberCanView(member, id), deps.picks);
  if (plan.unknownKeys.length) {
    log.error('session_picker_unknown_keys', { keys: plan.unknownKeys });
  }

  await i.editReply({ content: sessionAckText(plan) });

  // Idempotency half two: re-selecting records another channel_routed (it is
  // a repeatable funnel event, like voice sessions) but changes no member
  // state - there is none to change. The role-delta assertion in the staging
  // proof covers this directly.
  if (plan.channelIds.length) {
    await deps.recorder.routed(i.guild.id, member.id, plan);
  }
}

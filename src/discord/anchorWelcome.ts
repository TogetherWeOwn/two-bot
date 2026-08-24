/**
 * The routed welcome: one message, in the room the member arrived in, the
 * moment the rules gate clears.
 *
 * This is the discord.js half of src/onboarding/anchorEvent.ts and it is
 * deliberately thin. The decision of *whether* to post is not made here - it
 * comes from `decidePrompt()` in src/onboarding/flow.ts, unchanged, which
 * already gets the two things that are easy to get wrong right: waiting for
 * `pending` to clear (11 of the last 12 joins arrived gated) and the
 * once-per-member guard.
 *
 * Three rules that are enforced rather than intended:
 *
 *   ONE MESSAGE, NOTHING APPENDED. No components, no embed, no footer. TOG-93:
 *   "Please do not add anything to that message." The game picker is a separate
 *   surface - see registerGameSelect in ./onboarding.ts.
 *
 *   NO DMs. The only outbound path is a post in the configured channel.
 *
 *   THE DATE IS COMPUTED, NEVER STORED. Nothing in this file or its spec module
 *   holds "the next Sunday Squad" as a value that can go stale.
 */

import {
  Events,
  PermissionsBitField,
  type Client,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import { log } from '../core/log.ts';
import type { OnboardingRecorder } from '../onboarding/flow.ts';
import {
  SUNDAY_SQUAD,
  anchorWelcomeText,
  occurrenceContext,
  type AnchorEventSpec,
} from '../onboarding/anchorEvent.ts';

export interface AnchorWelcomeDeps {
  recorder: OnboardingRecorder;
  /**
   * Where the welcome goes: the text chat of the voice room the event runs in.
   * Defaults to the spec's own channel, which is the whole point of the design
   * - greeting and connect control on one screen.
   */
  channelId?: string;
  spec?: AnchorEventSpec;
  /** Injected so tests can stand at a chosen moment. Real callers omit it. */
  now?: () => number;
  /** Decide and log, post nothing, record nothing. Used by preflight. */
  dryRun?: boolean;
}

/** Can the bot post in here? A welcome we cannot send is worth saying out loud. */
function postableChannel(client: Client, channelId: string): GuildTextBasedChannel | null {
  const ch = client.channels.cache.get(channelId);
  // Voice channels are text-based in discord.js v14 - the "text chat in voice"
  // surface is the channel itself, which is why this takes one id and not two.
  if (!ch || !ch.isTextBased() || ch.isDMBased()) return null;
  const me = ch.guild.members.me;
  if (!me) return null;
  const perms = ch.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) return null;
  if (!perms.has(PermissionsBitField.Flags.SendMessages)) return null;
  return ch;
}

/**
 * Post the welcome for one member, if they are due one.
 *
 * Exported because the e2e suite drives it directly, and because a staff
 * command to re-run a member through onboarding will want it later. Safe to
 * call twice: the second call gets `already_prompted` from the store.
 */
export async function sendAnchorWelcome(
  client: Client,
  member: GuildMember,
  deps: AnchorWelcomeDeps,
): Promise<boolean> {
  const spec = deps.spec ?? SUNDAY_SQUAD;
  const channelId = deps.channelId ?? spec.channelId;
  const now = deps.now ?? Date.now;

  const decision = await deps.recorder.shouldPrompt({
    guildId: member.guild.id,
    memberId: member.id,
    isBot: !!member.user?.bot,
    pending: !!member.pending,
  });
  if (!decision.shouldPrompt) {
    log.debug('anchor_welcome_skip', { memberId: member.id, reason: decision.reason });
    return false;
  }

  const target = postableChannel(client, channelId);
  if (!target) {
    // Loud: this means every new member is silently getting nothing, which is
    // indistinguishable from a healthy quiet server until someone checks.
    log.error('anchor_welcome_no_channel', { channelId });
    return false;
  }

  const at = now();
  const ctx = occurrenceContext(at, spec);

  if (deps.dryRun) {
    log.info('anchor_welcome_dry_run', {
      memberId: member.id,
      channelId: target.id,
      startEpoch: ctx.startEpoch,
      near: ctx.near,
    });
    return false;
  }

  try {
    await target.send({
      content: anchorWelcomeText(`<@${member.id}>`, at, spec),
      // The mention is the whole point of this message existing; nothing else
      // in it may ping. No roles, no @everyone, even if the copy changes.
      allowedMentions: { users: [member.id], roles: [], parse: [] },
    });
  } catch (err) {
    log.error('anchor_welcome_failed', { memberId: member.id, err: String(err) });
    return false;
  }

  // Both events, in funnel order, only after the message is actually out.
  // Emitting before the send would let a failed post still count as a routed
  // member, which is the one way to make this number lie upwards.
  await deps.recorder.prompted(member.guild.id, member.id, target.id);
  await deps.recorder.routed(member.guild.id, member.id, {
    roleIds: [],
    destinations: [],
    // The room we sent them to. `degraded` is 0 by construction: unlike the
    // game rooms there is no fallback here, and a dark Lobby returns above.
    channelIds: [target.id],
    unknownKeys: [],
    degradedCount: 0,
  });

  log.info('anchor_welcome_sent', {
    memberId: member.id,
    channelId: target.id,
    startEpoch: ctx.startEpoch,
    live: ctx.live,
  });
  return true;
}

export function registerAnchorWelcome(client: Client, deps: AnchorWelcomeDeps): void {
  // Someone who accepted the rules on the invite screen and arrives ungated.
  client.on(Events.GuildMemberAdd, (member) => {
    if (member.pending) return; // GuildMemberUpdate will pick them up
    void sendAnchorWelcome(client, member, deps);
  });

  // The normal path on TWO: pending flips true -> false when they accept.
  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (oldMember.pending && !newMember.pending) {
      void sendAnchorWelcome(client, newMember as GuildMember, deps);
    }
  });
}

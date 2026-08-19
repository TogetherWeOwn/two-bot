/**
 * Where a join-burst alert goes.
 *
 * One outbound path: a post in a staff channel the CEO nominates. No DMs, no
 * pings at members, no @everyone, and nothing member-facing at all - the people
 * in the burst are never contacted by us. If no channel is configured the alert
 * still lands in the process log, which is the honest default: better a line in
 * the journal than a post in a guessed channel on a live server.
 */

import { PermissionsBitField, type Client, type GuildTextBasedChannel } from 'discord.js';
import { formatRaidAlert, type RaidAlert } from '../analytics/raidWatch.ts';
import { log } from '../core/log.ts';

export type RaidAnnouncer = (alert: RaidAlert) => Promise<void>;

export interface RaidAlertOptions {
  /** Staff channel for the alert. Null = log only. */
  channelId: string | null;
  /** Log what would be posted and post nothing. */
  dryRun?: boolean;
}

/** Can the bot post here? Same check onboarding makes before it picks a channel. */
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

export function makeRaidAnnouncer(client: Client, o: RaidAlertOptions): RaidAnnouncer {
  return async (alert: RaidAlert) => {
    // Always log first. If the post fails - wrong channel, permission removed,
    // Discord having a bad day - the evidence still exists somewhere.
    log.error('raid_alert', {
      guildId: alert.guildId,
      count: alert.count,
      spanSeconds: alert.spanSeconds,
      windowSeconds: alert.windowSeconds,
      firstJoinAt: alert.firstJoinAt,
      lastJoinAt: alert.lastJoinAt,
      repeat: alert.repeat,
      memberIds: alert.memberIds,
      truncated: alert.truncated,
    });

    if (!o.channelId) return;
    if (o.dryRun) {
      log.info('raid_alert_dry_run', { channelId: o.channelId });
      return;
    }

    const ch = botCanPost(client, o.channelId);
    if (!ch) {
      log.error('raid_alert_undeliverable', {
        channelId: o.channelId,
        reason: 'channel missing, not text, or bot lacks View/Send',
      });
      return;
    }

    try {
      // allowedMentions empty: the text contains user IDs in backticks, and a
      // formatting slip must never turn a staff heads-up into 50 pings.
      await ch.send({ content: formatRaidAlert(alert), allowedMentions: { parse: [] } });
      log.info('raid_alert_posted', { channelId: o.channelId, count: alert.count });
    } catch (err) {
      log.error('raid_alert_post_failed', { channelId: o.channelId, err: String(err) });
    }
  };
}

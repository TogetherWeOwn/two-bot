import { PermissionsBitField, type Client, type GuildTextBasedChannel } from 'discord.js';
import { log } from '../core/log.ts';
import type { ContainmentAlert, ContainmentAnnouncer, JoinRiskAlert } from '../moderation/containment.ts';

function botCanPost(client: Client, channelId: string): GuildTextBasedChannel | null {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  const me = channel.guild.members.me;
  if (!me) return null;
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) return null;
  if (!permissions.has(PermissionsBitField.Flags.SendMessages)) return null;
  return channel;
}

function restoreText(restore: Record<string, unknown> | undefined): string {
  if (!restore) return 'Restore check: unavailable.';
  if (restore.outcome === 'restore_required') return `Restore check: ${String(restore.operations)} additive operation(s) required from the accepted snapshot.`;
  if (restore.outcome === 'no_restore_needed') return 'Restore check: no configuration drift remains.';
  return `Restore check: ${String(restore.outcome ?? 'unknown')}.`;
}

export function formatContainmentAlert(alert: ContainmentAlert): string {
  return [
    `**Anti-nuke ${alert.outcome}** — destructive heat ${alert.heat}/${alert.threshold}.`,
    `Executor: \`${alert.executorId ?? 'unknown'}\` · action: \`${alert.action}\` · target: \`${alert.targetId ?? 'unknown'}\`.`,
    alert.removedRoleIds?.length
      ? `Removed dangerous roles (${alert.removedRoleIds.length}): ${alert.removedRoleIds.slice(0, 20).map((id) => `\`${id}\``).join(' ')}${alert.removedRoleIds.length > 20 ? ` …and ${alert.removedRoleIds.length - 20} more` : ''}.`
      : 'No role removal was confirmed.',
    restoreText(alert.restore),
    '',
    'No member join was kicked or banned by this feature. Verify the executor and run the guarded staging restore procedure if drift is reported.',
  ].join('\n');
}

export function formatJoinRiskAlert(alert: JoinRiskAlert): string {
  return [
    `**Join risk flag** — score ${alert.score}.`,
    `Member: \`${alert.memberId}\` · reasons: ${alert.reasons.join('; ') || 'none'}.`,
    'Flag only: Owen did not kick, ban, timeout, or message this member.',
  ].join('\n');
}

async function post(client: Client, channelId: string | null, content: string): Promise<void> {
  log.error('containment_alert', { content });
  if (!channelId) return;
  const channel = botCanPost(client, channelId);
  if (!channel) {
    log.error('containment_alert_undeliverable', { channelId });
    return;
  }
  try {
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (error) {
    log.error('containment_alert_post_failed', { channelId, err: String(error) });
  }
}

export function makeContainmentAnnouncer(client: Client, channelId: string | null): ContainmentAnnouncer {
  return async (alert) => post(client, channelId, formatContainmentAlert(alert));
}

export function makeJoinRiskAnnouncer(client: Client, channelId: string | null): (alert: JoinRiskAlert) => Promise<void> {
  return async (alert) => post(client, channelId, formatJoinRiskAlert(alert));
}

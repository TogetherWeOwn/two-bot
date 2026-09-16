export type OperationalAuditKind =
  | 'message_edit'
  | 'message_delete'
  | 'member_update'
  | 'voice_join'
  | 'voice_leave'
  | 'voice_move'
  | 'moderation_action';

export type AuditChannel = 'audit' | 'voice' | 'moderation';

export interface OperationalAuditEvent {
  entryId: string;
  kind: OperationalAuditKind;
  channel: AuditChannel;
  guildId: string;
  occurredAt: string;
  actorId?: string | null;
  targetId?: string | null;
  sourceChannelId?: string | null;
  destinationChannelId?: string | null;
  messageId?: string | null;
  action?: string | null;
  metadata?: Record<string, unknown>;
}

export function auditEventFields(event: OperationalAuditEvent): Record<string, unknown> {
  return {
    entryId: event.entryId,
    kind: event.kind,
    guildId: event.guildId,
    occurredAt: event.occurredAt,
    actorId: event.actorId ?? null,
    targetId: event.targetId ?? null,
    sourceChannelId: event.sourceChannelId ?? null,
    destinationChannelId: event.destinationChannelId ?? null,
    messageId: event.messageId ?? null,
    action: event.action ?? null,
    metadata: event.metadata ?? {},
  };
}

export function auditEventIdentity(entryId: string): string {
  return `audit-event:${entryId};`;
}

export function hasAuditEventIdentity(content: string, entryId: string): boolean {
  return content.startsWith(`${auditEventIdentity(entryId)} · `);
}

/** Metadata only: no message bodies, usernames or nicknames. */
export function formatAuditEvent(event: OperationalAuditEvent): string {
  const fields = [
    auditEventIdentity(event.entryId),
    `**${event.kind.replaceAll('_', ' ')}**`,
    `at ${event.occurredAt}`,
    `target \`${event.targetId ?? 'unknown'}\``,
  ];
  if (event.actorId) fields.push(`actor \`${event.actorId}\``);
  if (event.messageId) fields.push(`message \`${event.messageId}\``);
  if (event.sourceChannelId) fields.push(`from <#${event.sourceChannelId}>`);
  if (event.destinationChannelId) fields.push(`to <#${event.destinationChannelId}>`);
  if (event.action) fields.push(`action \`${event.action}\``);

  const metadata = Object.entries(event.metadata ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=\`${formatMetadata(value)}\``);
  if (metadata.length) fields.push(metadata.join(' '));
  return truncateDiscordContent(fields.join(' · '));
}

function formatMetadata(value: unknown): string {
  if (!Array.isArray(value)) return String(value).slice(0, 300);
  if (value.length === 0) return 'none';

  const items = value.map(String);
  const included: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const candidate = [...included, items[index]].join(',');
    const omitted = items.length - index - 1;
    const indicator = omitted > 0 ? ` (+${omitted} omitted)` : '';
    if (`${candidate}${indicator}`.length > 300) break;
    included.push(items[index]);
  }

  const omitted = items.length - included.length;
  if (omitted === 0) return included.join(',');
  const indicator = `+${omitted} omitted`;
  return included.length ? `${included.join(',')} (${indicator})` : indicator;
}

function truncateDiscordContent(content: string): string {
  if (content.length <= 2_000) return content;
  return `${content.slice(0, 1_996)}...`;
}

export type MigrationTable =
  | 'events'
  | 'members'
  | 'invite_snapshots'
  | 'moderation_warnings'
  | 'moderation_scheduled_unbans'
  | 'moderation_audit'
  | 'moderation_lockdowns'
  | 'moderation_idempotency'
  | 'tickets'
  | 'ticket_transcripts';

export function migrationValuesMatch(
  table: MigrationTable,
  column: string,
  source: unknown,
  target: unknown,
): boolean {
  if (table === 'members' && column === 'is_bot') {
    if (source === 0) return target === false;
    if (source === 1) return target === true;
    return false;
  }
  return source === target;
}

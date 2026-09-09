export type MigrationTable =
  | 'events'
  | 'members'
  | 'invite_snapshots'
  | 'moderation_warnings'
  | 'moderation_scheduled_unbans'
  | 'moderation_audit'
  | 'moderation_lockdowns'
  | 'moderation_idempotency'
  | 'operational_audit_log'
  | 'tickets'
  | 'ticket_transcripts';

export function migrationValuesMatch(
  table: MigrationTable,
  column: string,
  source: unknown,
  target: unknown,
): boolean {
  const sqliteBoolean =
    (table === 'members' && column === 'is_bot') ||
    (table === 'moderation_lockdowns' && column === 'prior_exists');
  if (sqliteBoolean) {
    if (source === 0) return target === false;
    if (source === 1) return target === true;
    return false;
  }
  return source === target;
}

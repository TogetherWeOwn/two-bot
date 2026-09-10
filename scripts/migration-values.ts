export type MigrationTable =
  | 'events'
  | 'members'
  | 'invite_snapshots'
  | 'moderation_warnings'
  | 'moderation_scheduled_unbans'
  | 'moderation_audit'
  | 'moderation_lockdowns'
  | 'moderation_idempotency'
  | 'containment_events'
  | 'containment_incidents'
  | 'join_risk_flags'
  | 'tickets'
  | 'ticket_transcripts'
  | 'automod_violations'
  | 'automod_processed_messages'
  | 'automation_commands'
  | 'scheduled_messages'
  | 'sticky_messages'
  | 'automation_audit_log';

function isSqliteBooleanColumn(table: MigrationTable, column: string): boolean {
  return (
    (table === 'members' && column === 'is_bot') ||
    (table === 'moderation_lockdowns' && column === 'prior_exists') ||
    (table === 'automation_commands' && column === 'enabled') ||
    (table === 'scheduled_messages' && column === 'enabled') ||
    (table === 'sticky_messages' && column === 'enabled')
  );
}

export function migrationValue(
  table: MigrationTable,
  column: string,
  value: unknown,
): unknown {
  if (!isSqliteBooleanColumn(table, column) || value === null || value === undefined) {
    return value ?? null;
  }
  return value === true || value === 1;
}

export function migrationValuesMatch(
  table: MigrationTable,
  column: string,
  source: unknown,
  target: unknown,
): boolean {
  if (
    isSqliteBooleanColumn(table, column) ||
    (table === 'join_risk_flags' && ['bulk_join_window', 'flagged'].includes(column))
  ) {
    if (source === 0) return target === false;
    if (source === 1) return target === true;
    return false;
  }
  return source === target;
}

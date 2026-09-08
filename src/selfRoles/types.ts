export type SelfRolePanelMode = 'button' | 'select' | 'reaction';

export interface SelfRoleOption {
  /** Stable, panel-scoped key placed in component custom ids and audit rows. */
  key: string;
  label: string;
  roleId: string;
  emoji?: string;
  description?: string;
}

export interface SelfRolePanel {
  /** Stable audit/config key. */
  id: string;
  channelId: string;
  messageId: string;
  mode: SelfRolePanelMode;
  /** At most one role from this panel may be held after a successful selection. */
  exclusive: boolean;
  /** Color-Chan semantics: an exclusive set whose roles carry Discord colors. */
  color: boolean;
  options: SelfRoleOption[];
}

export type SelfRoleAuditOutcome =
  | 'processing'
  | 'assigned'
  | 'removed'
  | 'switched'
  | 'already_held'
  | 'already_absent'
  | 'rejected';

export interface SelfRoleAuditRow {
  eventId: string;
  guildId: string;
  panelId: string;
  memberId: string;
  sourceId: string;
  optionKey: string | null;
  roleId: string | null;
  source: SelfRolePanelMode;
  operation: 'add' | 'remove' | 'replace';
  outcome: SelfRoleAuditOutcome;
  code: string | null;
  reason: string | null;
  addedRoleIds: string[];
  removedRoleIds: string[];
}

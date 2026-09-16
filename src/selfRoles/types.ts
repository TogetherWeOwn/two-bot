export type SelfRolePanelMode = 'button' | 'select' | 'reaction';

export interface SelfRoleOption {
  /** Stable, panel-scoped key placed in component custom ids and audit rows. */
  key: string;
  label: string;
  roleId: string;
  /** Exact Discord permission mask approved for this role at deployment. */
  permissions: string;
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
  eventOrder?: string;
  guildId: string;
  panelId: string;
  memberId: string;
  sourceId: string;
  optionKey: string | null;
  roleId: string | null;
  source: SelfRolePanelMode;
  operation: 'add' | 'remove' | 'replace';
  /** Stable requested target, never recomputed as a toggle during recovery. */
  desiredRoleIds?: string[];
  preMutationRoleIds?: string[];
  claimToken?: string;
  claimGeneration?: number;
  outcome: SelfRoleAuditOutcome;
  code: string | null;
  reason: string | null;
  /** Mutations that returned success from Discord. */
  addedRoleIds: string[];
  removedRoleIds: string[];
  /** Every mutation call made, including one whose result was ambiguous. */
  attemptedAddedRoleIds: string[];
  attemptedRemovedRoleIds: string[];
  /** Authoritatively observed changes restored after a failed mutation. */
  compensatedAddedRoleIds: string[];
  compensatedRemovedRoleIds: string[];
  /** Differences from the pre-mutation snapshot that could not be restored. */
  unresolvedAddedRoleIds: string[];
  unresolvedRemovedRoleIds: string[];
}

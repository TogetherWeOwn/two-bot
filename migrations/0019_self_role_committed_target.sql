-- Distinguish a durably accepted empty selection from a panel lane whose
-- initial authoritative target has not been established yet.
ALTER TABLE self_role_panel_claims ADD COLUMN IF NOT EXISTS target_committed BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE self_role_panel_claims AS claims
SET target_committed = TRUE
WHERE EXISTS (
  SELECT 1 FROM self_role_audit AS audit
  WHERE audit.guild_id = claims.guild_id
    AND audit.member_id = claims.member_id
    AND audit.panel_id = claims.panel_id
    AND audit.outcome IN ('assigned', 'removed', 'switched', 'already_held', 'already_absent')
);

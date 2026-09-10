-- Distinguish a durably accepted empty selection from a panel lane whose
-- initial authoritative target has not been established yet.
--
-- Earlier builds could publish latest_option_key before the corresponding
-- dispatch finished. Only backfill a target when the lane's latest_event_id is
-- itself a successful audit row whose persisted desired state resolves to the
-- same committed option. An empty desired set is a valid committed NULL target;
-- ambiguous rows stay uncommitted and are reseeded from authoritative Discord.
ALTER TABLE self_role_panel_claims ADD COLUMN IF NOT EXISTS target_committed BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE self_role_panel_claims AS claims
SET target_committed = TRUE
WHERE claims.target_committed = FALSE
  AND claims.latest_event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM self_role_audit AS audit
    WHERE audit.event_id = claims.latest_event_id
      AND audit.guild_id = claims.guild_id
      AND audit.member_id = claims.member_id
      AND audit.panel_id = claims.panel_id
      AND CASE
        WHEN jsonb_array_length(audit.desired_role_ids::jsonb) = 0 THEN NULL
        WHEN jsonb_array_length(audit.desired_role_ids::jsonb) = 1 THEN audit.option_key
        ELSE '__invalid_multi_target__'
      END IS NOT DISTINCT FROM claims.latest_option_key
      AND audit.outcome IN ('assigned', 'removed', 'switched', 'already_held', 'already_absent')
  );

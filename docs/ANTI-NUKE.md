# Anti-nuke containment

TOG-1650 adds a staging-only, fail-closed response to destructive Discord audit entries.

## Boundary

- Discord Raid Protection remains off.
- Join risk is **flag-only**. It never kicks, bans, times out, messages, or removes a role from a joining member.
- A bulk-join window (`TWO_BULK_JOIN_WINDOW_UNTIL`) suppresses flags for owner-initiated purchased joins while retaining the evidence row.
- Destructive actions are keyed by Discord audit-entry ID and counted per executor. Missing executors are recorded and never guessed.
- Containment removes only dangerous roles that sit below Owen. A role at or above Owen refuses the whole mutation before the first write.
- The gateway handler never auto-applies a guild restore. It compares current configuration to an accepted snapshot and reports the guarded additive restore plan.
- A Discord timeout is `uncertain` and is not automatically retried.

## Actions and heat

| Discord audit action | Heat |
|---|---:|
| kick, ban, webhook create/update/delete | 1 |
| channel delete, role delete | 3 |

The default trigger is heat 5 inside 60 seconds. Old audit entries (>120 seconds by default), explicitly trusted executors, and protected executors do not contribute.

## Staging enablement

Use only guild `1545644954272137297` with application `1469137636663758888` (`Owen QA Test`). `src/index.ts` refuses the live guild.

```dotenv
DISCORD_GUILD_ID=1545644954272137297
TWO_OWEN_USER_ID=1469137636663758888
TWO_MODERATION=1
TWO_ANTI_NUKE=1
TWO_ANTI_NUKE_DRY_RUN=1
TWO_ANTI_NUKE_SNAPSHOT_PATH=/var/backups/two-bot/guild-config/accepted.json
```

Armed containment (`TWO_ANTI_NUKE_DRY_RUN=0`) requires `TWO_MODERATION=1`: quarantine DELETEs the executor's dangerous roles, which is a moderation-path member-role write, so the moderation killswitch covers it. Boot refuses `TWO_ANTI_NUKE=1` + dry-run off without `TWO_MODERATION=1`, mirroring the `TWO_AUTOMOD=1` gate. Dry-run containment never reaches `quarantine()` and stays bootable without moderation (alerts only); join-risk scoring is flag-only and likewise needs no moderation. Turning moderation off therefore also disarms the quarantine drill — see [MODERATION.md](MODERATION.md) "Turning moderation off".

Start dry-run, prove audit delivery and the refusal paths, then switch dry-run off only for the staging quarantine drill. The application needs View Audit Log and Manage Roles; `npm run staging:verify` attempts the audit-log read directly.

For the repeatable exact-SHA gateway driver, staging-only actor requirements, bounded role-delete scenarios, per-run evidence, and fixture-scoped rollback, follow [`STAGING_ANTI_NUKE_ACCEPTANCE.md`](STAGING_ANTI_NUKE_ACCEPTANCE.md). Its default command is read-only; Discord writes require `drive --apply` and existing staging live-fire authorization.

Quarantine removes the executor's dangerous roles, which is a member-role write, so it cannot coexist with `TWO_ONBOARDING_MODE=session` — that mode's contract is zero role writes anywhere, not just on the onboarding path. Startup refuses the armed combination outright rather than failing at the first incident, when the write would already be the response to a live raid. The dry run stops before `quarantine()`, so `session` + `TWO_ANTI_NUKE=1` + `TWO_ANTI_NUKE_DRY_RUN=1` (alerts only) still boots. To run the quarantine drill, take the guild out of session mode first.

## Restore procedure

1. Contain the executor.
2. Read the alert's restore plan count and hashes.
3. Run `npm run restore:guild-config -- --snapshot <accepted-snapshot>` using the existing staging guards.
4. Repeat the dry run. Completion is zero remaining operations and semantic hash equality.

The restore engine is additive (POST/PATCH, no DELETE) and separately preflights permissions and hierarchy. It can still partially apply if Discord fails during a multi-write plan, so it is not run automatically from the gateway event.

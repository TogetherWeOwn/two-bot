# Leveling

TOG-1645 replaces MEE6 Levels without resetting member progress.

## XP rules

- Messages award 15 XP at most once per member per 60 seconds.
- Completed voice sessions award 5 XP per complete minute, at most once per member per 60 seconds.
- Bots and DMs earn nothing.
- Levels use MEE6's cumulative curve: `5/6 × level × (2×level² + 27×level + 91)`.
- `/rank [member]` reports level, guild rank and progress to the next level.
- `/leaderboard` reports the top ten members. Equal XP is ordered by Discord member id so results do not shuffle.

Cooldown claims and XP writes are one database transaction. Restarting the bot therefore cannot bypass the cooldown.

## Role rewards

The bot only grants roles explicitly configured in `level_role_rewards`. It never creates roles and never removes a reward already earned.

```sh
TWO_DATABASE_URL=postgres://... npm run levels:roles -- \
  --guild 1545644954272137297 \
  --set 5:ROLE_ID,10:ROLE_ID,20:ROLE_ID
```

`--set` replaces the full list atomically. Run without `--set` to inspect it. Discord still enforces Manage Roles and hierarchy; `scripts/staging-verify.ts` is the preflight for those permissions.

## Import a MEE6 export

Accepted JSON is either an array or `{ "players": [...] }`. Each row needs `id` (or `user_id`) and `xp`; `level` is optional and, when present, is reconciled against the XP curve.

```sh
TWO_DATABASE_URL=postgres://... npm run levels:import:mee6 -- \
  --guild 1545644954272137297 \
  --file mee6-levels.json
```

The command prints reconciliation counts: source rows, unique members, duplicate rows, inserted, updated, unchanged and imported XP total. Duplicate member rows resolve to the highest XP. Re-running the same export is a no-op for member state and reports every unique member as unchanged.

Imported, message and voice XP are stored separately. A corrected export replaces only `imported_xp`, preserving XP earned organically after the first import. Every run writes an aggregate row to `level_import_runs`; the export body is never copied into the audit table.

## Staging proof

Use only TWO Staging guild `1545644954272137297` and the Owen QA Test application.

1. Apply migration `0010_leveling` and configure disposable level roles below the bot.
2. Import a staging-only fixture, capture reconciliation counts, then re-import it and prove `inserted=0`, `updated=0`, `unchanged=uniqueMembers`.
3. Send two messages within 60 seconds and one after 60 seconds; verify only two awards.
4. Complete a voice session longer than one minute; verify voice XP and the cooldown.
5. Exercise `/rank` for self and another member, `/leaderboard`, and an empty-guild result.
6. Cross a configured level and verify the role is granted. Put a disposable role above the bot and verify the hierarchy failure is logged without crashing or granting it.
7. Confirm no request or write targeted live guild `326474832151838730`.

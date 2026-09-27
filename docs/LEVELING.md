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

The bot only grants roles explicitly configured in `level_role_rewards`. It never creates roles. The grant-side hook (`applyLevelRoles`) only adds earned rewards; its named revoker `removeLevelRoles` (TOG-4963, `src/leveling/discord.ts`) removes configured rewards the member no longer earns at their level. The revoker is staging-only (refuses the live guild via `assertStagingGuild` before any DB read or Discord write) and fail-closed: without Manage Roles, or when any target role is missing, managed, or not below the bot, the whole revoke is refused and logged, never applied partially. Discord write failures are logged, never thrown.

```sh
TWO_DATABASE_URL=postgres://... npm run levels:roles -- \
  --guild 1545644954272137297 \
  --set 5:ROLE_ID,10:ROLE_ID,20:ROLE_ID
```

`--set` replaces the full list atomically. Run without `--set` to inspect it. Discord still enforces Manage Roles and hierarchy; `scripts/staging-verify.ts` is the preflight for those permissions.

Migrating from MEE6? Do not hand-type the pairs — [probe the export's reward roles](#reward-roles-are-not-imported-probe-them-first) first.

## Import a MEE6 export

Accepted JSON is either an array or `{ "players": [...] }`. Each row needs `id` (or `user_id`) and `xp`; `level` is optional and, when present, is reconciled against the XP curve. A malformed export is rejected with *every* bad row listed, before anything opens a transaction.

### Merge semantics

Imported, message and voice XP are stored in separate columns and `member_levels` carries `CHECK (xp = message_xp + voice_xp + imported_xp)`.

| column | what the import does |
| --- | --- |
| `message_xp`, `voice_xp` | never written — organic XP is preserved by the column split |
| `imported_xp` | **overwritten** by the export's number |
| `xp` | the resulting sum |

The merge is **overwrite, not add**: adding would double-count every re-import. Because overwrite is symmetric, a stale export carrying a *lower* number would silently delete XP — so those rows are **skipped by default** and named in the manifest. `--allow-lower` applies them anyway.

### Take stock first

```sh
TWO_DATABASE_URL=postgres://... npm run levels:inventory -- --guild 1545644954272137297
```

Reports `memberRows`, `totalXp`, `totalOrganicXp` and `totalImportedXp` for the guild. Read-only, so it is not fenced off the live guild.

### Dry run, then apply

**Nothing is written without `--apply`.** The dry run produces the complete manifest.

```sh
TWO_DATABASE_URL=postgres://... npm run levels:import:mee6 -- \
  --guild 1545644954272137297 \
  --file mee6-levels.json \
  --manifest mee6-manifest.json
# looks right? add --apply
```

The manifest carries the file's `sha256` and size, `totalXpIn`, the full `accounting` block (rows in, duplicates, unique members, inserted, updated, unchanged, skipped), `rowsWritten`, `importedXpWritten`, every skipped row with the reason it lost, the inventory before and after, and both `totalXpAfterProjected` (derived from the export) and `totalXpAfterMeasured` (read back from the table).

`reconciled: false` means those two disagree, or the row counts do not balance, or the service reported different counts than the plan. **The command exits non-zero on it.** Exit codes: `0` fine, `1` the export or the write did not reconcile, `2` usage or the live-guild fence.

Duplicate member rows resolve to the highest XP, and the losing row is reported rather than dropped in silence. Re-running the same export is a no-op reporting every unique member as unchanged. Every applied run writes an aggregate row to `level_import_runs`; the export body is never copied into the audit table.

### Reward roles are not imported: probe them first

`levels:import:mee6` moves XP and **nothing else**. A MEE6 export's `role_rewards` section is read by no importer; the level → role ladder is configured by hand with `levels:roles --set`. Left there, an operator learns which of their reward roles Owen cannot actually grant at the moment a member levels up — where the failure is a swallowed `level_role_reward_failed` log line and a member who earned a role they never received.

`levels:roles:probe` answers that question first. It **has no `--apply`**: no write path exists in the script or in `src/leveling/rewardImport.ts`, it opens the database with migrations off, and its only statement is the `SELECT` behind the stored rewards. Guild roles come from a snapshot file rather than the network, so the probe is deterministic, runs offline, and cannot contact the guild it reports on.

```sh
TWO_DATABASE_URL=postgres://... npm run levels:roles:probe -- \
  --guild 1545644954272137297 \
  --file mee6-levels.json \
  --roles audit/raw/roles.json \
  --bot-id OWEN_APPLICATION_ID \
  --report reward-probe.json
```

Every reward lands in `mapped` or in `unmapped` with one of five reasons:

| reason | what it means |
| --- | --- |
| `role_absent` | the export names a role that no longer exists in the guild |
| `role_managed` | an integration owns it (a booster or another bot's role) — **no bot can ever grant it** |
| `above_bot_role` | at or above Owen's own top role. Discord compares strictly, so equal position also fails |
| `duplicate_level` | two roles at one level. `PRIMARY KEY (guild_id, level)` keeps one and **loses the other with no error** |
| `duplicate_role` | one role at two levels. `UNIQUE (guild_id, role_id)` **aborts the whole transaction** |

The last two are properties of `migrations/0010_leveling.sql`, not of Discord, and neither is visible from the export alone. A reward is only ever called a duplicate when it was otherwise importable — the reason reported is always the one that actually stopped it.

Pass `--owner-id` when Owen owns the guild (ownership bypasses hierarchy, and only hierarchy). The report also carries a `delta` against what is already stored, including **`removed`** — `replaceRoleRewards` deletes the guild's rows before inserting, so anything stored but absent from the export disappears on apply. Add `--require-all-mapped` to use the probe as a CI gate, and `--no-db` to run it with no database at all.

Exit codes: `0` fine, `1` the export is not importable or the report does not balance, `2` usage or the live-guild fence.

## Staging proof

Use only TWO Staging guild `1545644954272137297` and the Owen QA Test application.

1. Apply migration `0010_leveling` and configure disposable level roles below the bot.
2. Dry-run a staging-only fixture and keep the manifest, then `--apply` it, then re-apply it and prove `inserted=0`, `updated=0`, `unchanged=uniqueMembers` with `reconciled: true` each time.
3. Send two messages within 60 seconds and one after 60 seconds; verify only two awards.
4. Complete a voice session longer than one minute; verify voice XP and the cooldown.
5. Exercise `/rank` for self and another member, `/leaderboard`, and an empty-guild result.
6. Cross a configured level and verify the role is granted. Put a disposable role above the bot and verify the hierarchy failure is logged without crashing or granting it. Run `levels:roles:probe` against the same roles first and confirm it predicted that failure as `above_bot_role` — a probe that disagrees with the live grant is worse than no probe.
7. Confirm no request or write targeted live guild `326474832151838730`.

# AutoMod export schema (`scripts/automod-export.ts`)

Read this first if you need to map any field in the exported JSON back to
where it came from. One source query, one output file, no transforms.

## Command and output

```bash
npm run automod:export                        # writes audit/staging-automod-rules.json
node scripts/automod-export.ts audit/out.json # custom path
```

| Item | Value |
|---|---|
| Script | `scripts/automod-export.ts` |
| Validator | `src/automod/rulesExport.ts` (`validateAutomodRules`) |
| npm alias | `automod:export` (`package.json:84`) |
| Default output | `audit/staging-automod-rules.json` (`scripts/automod-export.ts:25`) |
| File mode | `0600` (bot token touched this host; the rules themselves are not secret) |
| Format | **JSON only.** There is no CSV output. `scripts/audit-report.ts` does not consume automod rules into any CSV. If you need a CSV, convert with `jq` by hand — do not assume column names from `channels.csv`/`roles.csv` apply here. |

## Source query (all fields come from this one call)

| Export | Source |
|---|---|
| Every rule object in the file | `GET https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules` (`scripts/automod-export.ts:10`), i.e. Discord [List Auto Moderation Rules for Guild](https://docs.discord.com/developers/resources/auto-moderation#list-auto-moderation-rules-for-guild). Requires `MANAGE_GUILD`. No query params, no pagination. |
| `guildId` in that URL | `stagingGuildId()` (`src/staging/spec.ts:278`): `DISCORD_STAGING_GUILD_ID` must equal TWO Staging `1545644954272137297`; anything else (including live `326474832151838730`) throws before any network call. |
| Auth header | `Bot ${DISCORD_STAGING_BOT_TOKEN}`, pre-checked by `checkStagingToken` (`src/staging/spec.ts:98`): refuses the live bot, the retired `test-two` app, and any unknown application id before contacting Discord. |

The same endpoint is used for the live-guild audit snapshot at
`scripts/audit-collect.ts:264` → `audit/raw/automod_rules.json`. That is the
live guild; this export is the staging guild. Same schema, different guild.

## Rule fields → source

The export writes Discord's rule objects **verbatim** — the validator returns
them unchanged (`src/automod/rulesExport.ts:64`). Field definitions below are
from the [Auto Moderation Rule Object](https://docs.discord.com/developers/resources/auto-moderation#auto-moderation-rule-object)
docs; "unit" is what the value means in practice.

| JSON field | Source query field | Type / unit | Notes |
|---|---|---|---|
| `id` | `GET .../auto-moderation/rules` → `[][].id` | Discord snowflake string, validated as `^\d{17,20}$` (`src/automod/rulesExport.ts:56`) | Identity. A rule without a valid id aborts the whole export (see below). |
| `name` | `[][].name` | non-empty string (`src/automod/rulesExport.ts:60`) | Identity. A blank/missing name aborts the whole export. |
| `guild_id` | `[][].guild_id` | snowflake; always `1545644954272137297` for this export | Pass-through; not validated, not rewritten. |
| `creator_id` | `[][].creator_id` | snowflake (user id) | Pass-through. This is a user id retained in the file — the one PII-adjacent field. `audit-scrub.ts` does **not** strip it (it only covers `user`/`inviter`/`target_user`/`bot` keys). |
| `event_type` | `[][].event_type` | enum integer (no unit) | `1` = `MESSAGE_SEND` (message sent or edited), `2` = `MEMBER_UPDATE` (profile edited). Observed: always `1` in both checked-in payloads. |
| `trigger_type` | `[][].trigger_type` | enum integer (no unit) | `1` = `KEYWORD`, `3` = `SPAM`, `4` = `KEYWORD_PRESET`, `5` = `MENTION_SPAM`, `6` = `MEMBER_PROFILE`. Max per guild: 6× keyword, 1× each other type. |
| `trigger_metadata` | `[][].trigger_metadata` | object; shape depends on `trigger_type` | Pass-through. See trigger-metadata table below. May be `{}` (e.g. SPAM rule). |
| `actions` | `[][].actions` | array of action objects | Pass-through. See actions table below. |
| `enabled` | `[][].enabled` | boolean | `true` = rule fires. The staging rule and all three live rules are `true`. |
| `exempt_roles` | `[][].exempt_roles` | array of role snowflakes (max 20) | Empty `[]` in every checked-in payload. |
| `exempt_channels` | `[][].exempt_channels` | array of channel snowflakes (max 50) | Live keyword/spam rules exempt `1058572809607073832`; staging mention-spam rule exempts none. |

Any **other** top-level field Discord adds later passes through untouched
(`AutomodExportRule` has `[key: string]: unknown`,
`src/automod/rulesExport.ts:15-19`). The validator only checks `id` and
`name`; it never strips, renames, or defaults anything else.

## `trigger_metadata` fields → source

From [`trigger_metadata`](https://docs.discord.com/developers/resources/auto-moderation#auto-moderation-rule-object-trigger-metadata).
Only the fields relevant to the rule's `trigger_type` appear.

| JSON field | Unit | Applies to | Observed in repo |
|---|---|---|---|
| `keyword_filter` | array of strings, ≤1000 entries, ≤60 chars each; `*` prefix/suffix/anywhere wildcards, case-insensitive | `KEYWORD` (1), `MEMBER_PROFILE` (6) | not present in checked-in payloads |
| `regex_patterns` | array of strings, ≤10 entries, ≤260 chars each, Rust regex flavor | `KEYWORD` (1), `MEMBER_PROFILE` (6) | not present |
| `presets` | array of integers: `1` = PROFANITY, `2` = SEXUAL_CONTENT, `3` = SLURS | `KEYWORD_PRESET` (4) | live rule `1094278154417352866` has `[1, 2, 3]` |
| `allow_list` | array of strings, ≤60 chars each; ≤100 entries for KEYWORD/MEMBER_PROFILE, ≤1000 for KEYWORD_PRESET | `KEYWORD`, `KEYWORD_PRESET`, `MEMBER_PROFILE` | live rule has `[]` |
| `mention_total_limit` | **count** of unique role+user mentions allowed per message, integer ≤50 | `MENTION_SPAM` (5) | `20` in both staging and live mention-spam rules |
| `mention_raid_protection_enabled` | boolean | `MENTION_SPAM` (5) | `true` in both mention-spam rules |

Unknown keys inside `trigger_metadata` pass through like any other field —
never stripped, never validated.

## `actions[]` fields → source

From the [Action Object](https://docs.discord.com/developers/resources/auto-moderation#auto-moderation-action-object)
docs. `actions` order is Discord's execution order.

| JSON field | Unit | Values |
|---|---|---|
| `type` | enum integer (no unit) | `1` = `BLOCK_MESSAGE`, `2` = `SEND_ALERT_MESSAGE` (log to channel), `3` = `TIMEOUT` (KEYWORD and MENTION_SPAM rules only, needs `MODERATE_MEMBERS`), `4` = `BLOCK_MEMBER_INTERACTION` |
| `metadata.channel_id` | channel snowflake | Only on `type: 2`. Live rules log to `1058572809607073832`. |
| `metadata.duration_seconds` | **seconds**, integer ≤ 2419200 (4 weeks) | Only on `type: 3`. Absent from all checked-in payloads (no TIMEOUT action configured). |
| `metadata.custom_message` | string ≤150 chars, shown to the blocked member | Optional on `type: 1`. Absent from all checked-in payloads. |
| `metadata` | `{}` (empty object) | Normal on `type: 1` block actions with no custom message — **not** an error or a redaction. |

## Unknown and malformed handling (the part that bites)

1. **Extra fields are kept.** The validator's contract is "returns the rules
   unchanged" (`src/automod/rulesExport.ts:43-48`). A new Discord field, a new
   `trigger_metadata` key, a future `trigger_type: 7` — all land in the file
   exactly as Discord sent them. Do not treat an unfamiliar key as corruption.
2. **Bad identity aborts everything, writes nothing.**
   `scripts/automod-export.ts:17-24` refuses a partial file: a non-array
   payload, a non-object row, an `id` that is not a 17–20-digit string, or a
   missing/blank `name` each produce one `row N …` problem, all collected into
   a single `AutomodExportError`, printed to stderr, `process.exit(1)` — and
   **no file is written**. A partial file that looks complete is treated as
   worse than no file (TOG-5700).
3. **Empty is valid.** `[]` in → `[]` out: an empty guild writes a two-byte
   `[]` file, not an error (pinned in
   `test/unit.backfillmessagesacceptance.test.ts:295-297`).
4. **Deterministic.** Re-validating the same payload yields byte-identical
   output (pinned `:287-293`). `git diff` on the export is a real signal.
5. **Units to not invent.** `mention_total_limit` is a count, not seconds.
   `duration_seconds` is seconds, not milliseconds (contrast the custom engine's
   `repeatedMessageWindowSeconds` in `src/automod/types.ts`, which is a
   different system — see below). Snowflakes are opaque ids, not timestamps.

## What this export is NOT

- **Not the custom engine.** `src/automod/matcher.ts` / `service.ts` /
  `types.ts` (`bad_words`, `repeated_message`, `mention_spam`, `invite_link`,
  `external_link`, `attachment_type` filters and the
  `automod.<filter>` audit rows) are TWO's own bot-side engine. This export
  covers only Discord's **native** AutoMod rules. The names overlap
  (`mention_spam`) but the systems are separate — a native-rule change never
  appears in `automod.*` audit rows and vice versa.
- **Not a CSV.** Acceptance mentions "CSV/JSON column" because the audit
  family mostly ships CSVs; this export has no CSV form and no column mapping.
  Every "column" is a JSON path in the table above.
- **Not scrubbed.** Unlike `audit/raw/*` (see `audit/README.md` Privacy),
  `creator_id` survives. Do not paste the export into a public channel.

## Worked examples (checked-in payloads)

- `audit/staging-automod-rules-2026-09-09.json` — the staging guild on
  2026-09-09: exactly one rule, `Block Mention Spam`
  (`1030554520465440818`), `trigger_type: 5`, `mention_total_limit: 20`,
  raid protection on, single `BLOCK_MESSAGE` action, enabled, no exempts.
  Described in `audit/staging-automod-corpus.md:6`.
- `audit/raw/automod_rules.json` — the live guild: three rules.
  `1094278154417352866` (`Block Commonly Flagged Words`, `trigger_type: 4`,
  presets `[1,2,3]`, alert to `1058572809607073832`);
  `1094278280623964290` (`Block Suspected Spam Content`, `trigger_type: 3`,
  block + alert); `1030554520465440818` (`Block Mention Spam`,
  `trigger_type: 5`, same 20-mention shape as staging).

## Re-running and verifying without Discord

```bash
node --test test/unit.backfillmessagesacceptance.test.ts  # pins determinism, empty-ok, every-bad-row-named, non-array rejection
```

The validator is pure and offline — no token, no network, no database
(`src/automod/rulesExport.ts:11`). The script itself always hits Discord;
there is no `--dry-run`.

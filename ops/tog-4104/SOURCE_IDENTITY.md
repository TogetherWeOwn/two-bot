# TOG-4104 source identity — live `f5fd3e1` vs reviewed `910c91c5`

Measured from the two-bot mirror (`git@135.148.42.223:/srv/git/two-bot.git`
via GitHub `TogetherWeOwn/two-bot`). Operator receipt 02:17Z attributed;
blob/tree comparisons below were run by the packet author and are
re-runnable from §0 of the runbook.

## Topology

- Live image revision: `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90`
  (`TOG-3471: temp-voice join-to-create slice, staging only`, parent `2899c29`).
- Previously reviewed merge: `910c91c510913f40a5e8bb4603d59554583a0e15`
  (`TOG-3101: record the CEO's allowlist sign-off in the changelog (#138)`).
- Merge-base(live, reviewed) = `2899c2955339043543fda4b899ce780f70712749`
  (`TOG-3189: disable automations deregisters DB-backed slash commands`).
  The live image is a SIBLING fork off that base, not a descendant of the
  reviewed merge. Ancestry alone proves nothing about deployed bytes.
- Mirror `origin/main` (`99fb7e574f490f58f684a4d45d1eafc6dd8ec31d`) contains
  the reviewed merge but NOT the live image. Current main is not the live
  image and must not be substituted for it.

## Bounded equivalence: the settings wire path is byte-identical

`git rev-parse <rev>:<path>` on both revisions; every row SAME except where
noted:

| surface | live | reviewed | verdict |
|---|---|---|---|
| `src/internal/actions.ts` | `f6ce4baf…` | `f6ce4baf…` | SAME (allowlist, `requireSettingsKey`, settings handlers, idempotency set) |
| `src/internal/server.ts` | `5fe4244…` | `5fe4244…` | SAME (HMAC verify, skew, nonce, idempotency claim, error envelope) |
| `src/internal/signing.ts` | `8a0e555…` | `8a0e555…` | SAME (canonical `POST\n/path\nts\nnonce\nsha256`, constant-time compare) |
| `src/internal/config.ts` | `8acdc0a…` | `8acdc0a…` | SAME (env-only gates, `TWO_INTERNAL_ALLOW_SETTINGS`) |
| `src/internal/bind.ts`, `errors.ts`, `nonce.ts`, `rateLimit.ts`, `discordActions.ts`, `store.ts` | | | SAME |
| `src/core/settings.ts` | `820bce9…` | `820bce9…` | SAME (store, audit write, poll, env snapshot) |
| `src/staging/spec.ts` | | | SAME (staging guild/app pins) |
| `migrations/0002_internal_actions.sql`, `0026_guild_settings.sql`, `0027_guild_settings_env_only.sql` | | | SAME (tables, audit, CHECK constraints) |
| `src/audit/*`, `src/staging/auditAcceptance.ts` etc. | | | SAME |
| `Dockerfile` | `d82c2d1…` | `d82c2d1…` | SAME |
| settings handler tests (`unit.internalsettings`, `unit.internalstore`, `unit.internalauth`, `unit.internalconfig.envonly`, `unit.settingsstore`, `e2e.internalactions`) | | | SAME blobs |
| `docs/INTERNAL_ACTIONS.md` | `b455591…` | `2229494…` | DIFF — changelog prose only (see below) |

## Deltas that exist and why they do not move the proof

1. `docs/INTERNAL_ACTIONS.md`: the reviewed merge records the CEO's
   allowlist sign-off (interaction `99e9e289`, staging-first condition);
   the live image predates that line. PROSE ONLY — no code, no wire
   format, no gate. The allowlist it documents is unchanged and already
   approved; this packet changes no allowlist entry.
2. `src/core/settingsCatalog.ts` + `src/core/config.ts` + `src/index.ts`:
   the reviewed tree wires `DISCORD_LANDING_CHANNEL_IDS` and
   `TWO_AUTOMOD_REPEAT_COUNT` hot (TOG-3536); the live image has only the
   raid pair hot-wired. The proof key pair (`TWO_RAID_JOIN_THRESHOLD` /
   `TWO_RAID_WINDOW_SECONDS`) is wired at BOTH — `HOT_WIRED`,
   `HOT_WIRED_FIELDS`, and live `liveCfg` thunk consumers verified at the
   live revision. The unwired keys are out of scope for this proof.
3. TOG-3471 temp-voice surface (`src/tempVoice/*`, migration `0028`,
   `BOT_TABLES` additions, `TEMP_VOICE_*` env-only catalog entries):
   staging-only, env-only, disjoint from the settings wire path.
4. Current main adds `event.cancel` (+ `TWO_INTERNAL_ALLOW_EVENT_CANCEL`).
   Not present at live, not touched by the probe.

## What is NOT claimed

- Full runtime equivalence. 43 files differ between the two trees; the
  claim covers the settings wire path listed above, not the bot.
- Build identity beyond the Dockerfile blob. Base-image digests and the
  `npm ci` layer are not pinned in-tree; the operator's image-revision
  check (`f5fd3e1…` in `docker ps`) is the enforcement point.
- Live acceptance. This packet is preparation + offline verification.
  The live call happens on [TOG-3706](/TOG/issues/TOG-3706) after
  independent review, green checks, and non-author merge.

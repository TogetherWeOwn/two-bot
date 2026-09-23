# Source identity: bounded settings proof, not runtime equivalence

This is Git-object evidence, rechecked during the correction of
[TOG-4104](/TOG/issues/TOG-4104). The operator's 2026-09-23 02:17Z receipt identifies
the image revision; no agent inspected or executed in that container. Proof code
and accepted runtime are independently pinned by `run-proof.sh`.

## Revision topology

- Accepted runtime `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90`, tree
  `010a591ac1580a9a822c07d272389eb9b6de8bf9`.
- Prior reviewed merge `910c91c510913f40a5e8bb4603d59554583a0e15`, tree
  `d34533223b2ddc1212cc0706d44cb655d453b046`.
- Merge-base `2899c2955339043543fda4b899ce780f70712749`.
  Neither revision is an ancestor of the other. They are sibling forks.
- Recorded mirror-main snapshot `99fb7e574f490f58f684a4d45d1eafc6dd8ec31d`
  is historical context, **not an instruction to deploy current main**.

Reproduce against the exact objects (no moving refs, no abbreviated/ellipsis SHA):

```bash
LIVE=f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
REVIEWED=910c91c510913f40a5e8bb4603d59554583a0e15
git cat-file -t "$LIVE"
git cat-file -t "$REVIEWED"
git merge-base "$LIVE" "$REVIEWED"
git diff --name-status "$REVIEWED" "$LIVE"
git diff --numstat "$REVIEWED" "$LIVE"
for p in src/internal src/core/settings.ts src/audit src/store migrations \
  src/core/config.ts src/core/settingsCatalog.ts src/index.ts \
  src/discord/commandNames.ts package.json package-lock.json tsconfig.json Dockerfile; do
  printf '%s\n' "$p"
  git rev-parse "$LIVE:$p" "$REVIEWED:$p"
done
```

## Identical source surfaces

These blobs/trees are identical at both accepted runtime and prior review:

| Path | Full Git object ID |
|---|---|
| `src/internal` tree | `e39bf25a6ec6d9762ef4cbf315b3bf3a8e8e1d8f` |
| `src/internal/actions.ts` | `f6ce4baf2f1e79ee5c439354cc94d7fb5825cbfc` |
| `src/internal/server.ts` | `5fe42441a964a5c4c2bbd4758d305ee2cdc2fa92` |
| `src/internal/signing.ts` | `8a0e55506b3a784fc86afdc377a5f499aed2e8aa` |
| `src/internal/config.ts` | `8acdc0a80991eca81a8e55cfa1d670781c30c52e` |
| `src/internal/store.ts` | `46f177918eb085837a50889d4afe862c4f6abcf2` |
| `src/internal/bind.ts` | `8830b9fb689b4886ee2d10be4e3a420af52cd64d` |
| `src/core/settings.ts` | `820bce9cfc9fd32696b89debc8efb0ed56f4fa90` |
| `src/audit` tree | `e99b44c93f8ef3c0388240fb502fd6836286247b` |
| `src/staging/spec.ts` | `444ad0995f03aede92560fa318d3e896a869031f` |
| `migrations/0002_internal_actions.sql` | `3f8e88c94d3d7dce1f1a66b0e0fdd967cb4ec524` |
| `migrations/0026_guild_settings.sql` | `216db533d22a6f200a3fa9cdf73bd26aaa7d8025` |
| `migrations/0027_guild_settings_env_only.sql` | `23db0c4c627d510c888c2425225ce19ea5c6826e` |
| `Dockerfile` | `d82c2d1e4b88b15c57ca9ded5e56d9fba657993f` |
| `package-lock.json` | `b8d4189d2dfb40331da527b6ed4952b8e16a807b` |
| `tsconfig.json` | `5018def2d94aa9b41e8872e9c35d063427bdef7f` |

The internal tree includes the HTTP/auth canonical serializer, key ring,
nonce/skew/rate-limit/error path, action allowlist and idempotency storage.
Canonical input is five fields joined by literal LF, without a trailing LF:
`POST`, `/internal/actions`, timestamp, nonce, SHA256 of actual raw request bytes.
Malformed-present signature, tampered body and unknown key ID all map to 401.

**Important correction to the first packet:** `settingsGet` returns the actual
stored JSON value, or `{source: "unset", value: null}`; it never reads through to
the environment. `SettingsStore.get` reads its cache. `set` writes a DB transaction
with audit and version/count invalidation but does not synchronously refresh
that cache. Default poll is 15 seconds. The revised executable captures exact
values, polls for exact readback, and restores through this same signed API.

The DB layer is `src/store`, not `src/db`. `db.ts`, `driver.ts`, `migrate.ts`,
`postgresDriver.ts` and the other unchanged store files were compared; the only
store-tree delta is `webRoleCheck.ts` (temp-voice table classification).

## Transitive differences that constrain the conclusion

Identical entrypoint blobs do **not** make the entire imported program identical.
There are 43 changed paths from reviewed to live: 9 added, 7 deleted, 27 modified;
numstat totals +3306/-2151. Full path manifest is reproduced by the command above.

| Changed surface | Live object | Reviewed object | Bounded impact |
|---|---|---|---|
| `src/core/settingsCatalog.ts` | `dca8f67259eb7e812f6f93e4ddf70b403fec6861` | `dfae4752e04d6c55d31c3cc9b552e920d5e68998` | Live adds 12 env-only temp-voice keys; only raid pair hot-wired |
| `src/core/config.ts` | `ca2d5a350cdd6105dc95e13d64aa5e0ef5c4a23d` | `5436ca30ff0302e932fcb6532acc5071622441e5` | Reviewed additionally hot-wires landing/automod, not selected by proof |
| `src/index.ts` | `45775ab4d39d25c7e18277dc4e6945b46e8c0ee1` | `291a007121e6b7d07fce7d63c7b5782ee3615b3b` | Live adds staging temp-voice services; raid liveCfg thunks present at both |
| `src/discord/commandNames.ts` | `0b4835b3d838ecbe45f0d8aa5f2f790f8637702e` | `615bae6707e469416f2254e72b9daabb58622ca7` | Imported by actions; temp-voice command additions, not settings handler |
| `package.json` | `485725d386a6519e56c3dcdb404c34d822bff51d` | `8512f5c129a6aa66889db5ec69752b782d9bf053` | Two snowflake-check script entries differ; dependency/devDependency objects identical |
| `docs/INTERNAL_ACTIONS.md` | `b4555910c50556adb7d08ec96140a9675d368730` | `22294942d9ca86b738f13d5f1d1e037edb8066f2` | Reviewed includes allowlist approval prose; no wire change |

Other changed paths are temp-voice implementation/migration, feed/automod,
onboarding/sessionWelcome/live-cleanup, the staging temp-voice check, ops/scripts,
CI and tests. `0028_temp_voice.sql` adds three temp-voice tables and adjusts
`BOT_TABLES`; it does not replace the settings/audit schema. `src/staging` and
`src/store` as whole trees are **different**, even though the selected staging
pins and DB driver are identical. Startup and unrelated service behavior are
outside this proof's claim, not certified equivalent.

The selected `TWO_RAID_JOIN_THRESHOLD`/`TWO_RAID_WINDOW_SECONDS` entries and
`HOT_WIRED_FIELDS` mappings are present at both revisions; `RaidWatch` consumes
`liveCfg` thunks at both. This supports the bounded choice of those two keys,
not a claim about other catalog keys or current-main actions.

Test evidence is similarly bounded: `unit.internalsettings`, `unit.internalstore`,
`unit.internalauth`, `unit.internalconfig.envonly`, `unit.settingsstore`, and
`e2e.internalactions` are byte-identical. `e2e.settingshotreload` and
`unit.settingscatalog` differ; `unit.internalsettingsaudit` is absent at live.
Do not call the entire settings test surface identical.

## Identity limitations and HOLD rule

- Static Git comparison, not a live execution result. Source facts about cache,
  authentication and wiring are not evidence that the operator's container passed.
- `Dockerfile` uses floating `node:24-bookworm-slim`, `WORKDIR /app`, `USER node`,
  `CMD ["node","src/index.ts"]`. Matching Dockerfile/lockfile does not attest base
  image digest, installed modules, build context, local edits or mounted overlays.
- `run-proof.sh` enforces the measured revision in exact-container image metadata,
  captures immutable image ID, and refuses drift. It does not prove deployed bytes
  from ancestry, a tag or a label. If the operator cannot trust that image/source
  mapping, HOLD for verified image provenance (or a separately reviewed pinned
  rebuild of the accepted source), not blind deployment of main.
- The live write contract has no CAS. Mandatory external writer exclusion and
  interrupted-run recovery limitations are explicit in [RUNBOOK.md](RUNBOOK.md).
- No full-runtime equivalence, website non-admin denial or live acceptance is
  claimed. Historical allowlist approval is not approval of this amended probe.

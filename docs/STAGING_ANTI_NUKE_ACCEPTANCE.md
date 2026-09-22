# TWO Staging anti-nuke gateway acceptance

This runbook prepares the executable prerequisite for TOG-3533. It does not claim the final QA verdict.

The acceptance runtime is pinned to exactly:

```text
f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
```

The driver can be versioned later than that runtime because it is an external observer and fixture controller. It requires a separate, clean checkout at the target SHA and a deployment evidence reference that names the same SHA. It never silently substitutes the driver checkout or current `main` for the accepted runtime.

## Hard fences

The driver refuses unless all of these are true:

- guild is exactly TWO Staging `1545644954272137297`;
- Owen is exactly the `Owen QA Test` application `1469137636663758888`;
- the target checkout and reported staging deployment are exactly `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90`;
- the destructive actor is a separate, bot-only application, is in TWO Staging, is not in live guild `326474832151838730`, and has no pre-existing dangerous role;
- one Postgres advisory lock protects the whole E2E job;
- at most two destructive actions occur: deletion of two roles created for this run;
- every fixture name and audit-log reason contains `TWO_ACCEPTANCE_RUN_ID`;
- cleanup addresses only role IDs written into this run's manifest;
- the current guild semantic hash matches the accepted snapshot before the first write and returns to the same hash after cleanup.

The driver accepts bot tokens only. Discord prohibits automating normal user accounts; a real join observation therefore requires a person to operate a disposable human account manually. No user token is requested or accepted.

Official contracts used by the driver:

- [Guild role create, position, assignment, removal, and deletion](https://docs.discord.com/developers/resources/guild)
- [Guild audit log and audit-log reasons](https://docs.discord.com/developers/resources/audit-log)
- [Gateway audit-entry and member-add events](https://docs.discord.com/developers/topics/gateway-events)
- [Discord rate-limit handling](https://docs.discord.com/developers/topics/rate-limits)
- [Discord's self-bot prohibition](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)

## Required non-secret inputs

| Input | Requirement |
|---|---|
| `TWO_ACCEPTANCE_RUN_ID` | Unique 6-48 character run label. Use a new value for every dry-run, armed, or join scenario. |
| `TWO_ACCEPTANCE_TARGET_REPO` | Clean checkout whose `HEAD` is the exact target SHA. |
| `TWO_STAGING_DEPLOYED_SHA` | Exact target SHA, copied from deployment evidence rather than typed from memory. |
| `TWO_STAGING_DEPLOYED_SHA_SOURCE` | URL or durable reference for the deployment evidence that reported the SHA. |
| `DISCORD_STAGING_GUILD_ID` | Must be `1545644954272137297`. |
| `TWO_STAGING_ACTOR_APPLICATION_ID` | Public ID of a staging-only disposable bot app, different from Owen. Required by `preflight` and `drive`. |
| `TWO_STAGING_DATABASE_URL` | Staging/test Postgres database URL. |
| accepted guild snapshot | Snapshot configured for the runtime's `TWO_ANTI_NUKE_SNAPSHOT_PATH`; supplied with `--snapshot`. |
| `TWO_AUDIT_ACCEPTANCE_SINCE` | Fresh ISO lower bound immediately before the complete acceptance window. |
| `TWO_SELF_ROLE_PANELS` | Non-empty, full button/select/reaction panel configuration consumed by `staging-verify.ts`. |
| `DISCORD_GOODBYE_CHANNEL_IDS` | Non-empty ordered goodbye-channel IDs consumed by `staging-verify.ts`. |

Secrets are injected through the normal secret mechanism and never written to arguments, evidence, or logs:

- `DISCORD_STAGING_BOT_TOKEN` — Owen QA Test only;
- `DISCORD_STAGING_ACTOR_BOT_TOKEN` — staging-only disposable bot only.

Do not use the live bot token, a normal user token, or a bot that belongs to the live guild.

## Full verifier evidence prerequisites

`staging:anti-nuke` does not weaken or replace `staging:verify`. The final verifier still requires all of the following after its fresh lower bound:

1. self-role button, select, reaction, multiple-panel, exclusive, and color-panel configuration;
2. a postable goodbye channel and, when `TWO_GOODBYE_VERIFY_SINCE` is set, a real goodbye message;
3. one durable and delivered row plus exactly one Discord marker for each operational audit kind:
   - `message_edit`
   - `message_delete`
   - `member_update`
   - `voice_join`
   - `voice_leave`
   - `voice_move`
   - `moderation_action`
4. one audit-sink tamper observation with no recursive mirror;
5. one successful Discord-mutating moderation action, such as reversible `moderation.slowmode`, correlated to its Discord audit entry;
6. the normal guild, hierarchy, private sink, permission, intent, temp-voice, and database checks.

The historical 11/11 run that called observers directly is synthetic database evidence. It must remain labeled synthetic and cannot satisfy gateway receipt or real join observation.

Goodbye implementation/evidence remains owned by TOG-3467 and TOG-3314; do not duplicate that parity work in this driver. Arbitrary message spam is not a destructive audit scenario and is not used.

## Prepare the exact target checkout

Use an isolated checkout; do not move the driver branch to the old target SHA.

```bash
git fetch origin f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
TARGET_DIR="$PAPERCLIP_RUN_SCRATCH_DIR/two-bot-target-f5fd3e1"
git worktree add --detach "$TARGET_DIR" f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
git -C "$TARGET_DIR" rev-parse HEAD
git -C "$TARGET_DIR" status --porcelain
npm ci --include=dev --prefix "$TARGET_DIR"
```

The first command must print the exact target. The second must print nothing.

Run the driver from the reviewed driver checkout, with its dependencies installed. The bot process being accepted must be the separately evidenced exact-target staging deployment.

## Read-only preflight

```bash
export TWO_ACCEPTANCE_RUN_ID="tog-3787-qa-$(date -u +%Y%m%dT%H%M%SZ)"
export TWO_ACCEPTANCE_TARGET_REPO="$TARGET_DIR"
export TWO_STAGING_DEPLOYED_SHA="f5fd3e1d6d08847589d3bf48ebc0b0e198196e90"
export TWO_STAGING_DEPLOYED_SHA_SOURCE="<deployment evidence URL or durable reference>"
export DISCORD_STAGING_GUILD_ID="1545644954272137297"
export TWO_STAGING_ACTOR_APPLICATION_ID="<staging-only bot application id>"
export TWO_AUDIT_ACCEPTANCE_SINCE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
RUN_DIR="$PAPERCLIP_RUN_SCRATCH_DIR/$TWO_ACCEPTANCE_RUN_ID"
mkdir -p "$RUN_DIR"

npm run staging:anti-nuke -- \
  preflight \
  --snapshot "$ACCEPTED_SNAPSHOT" \
  --output "$RUN_DIR/preflight.json"
```

Preflight writes no Discord state and makes no database mutation. It checks identities, target/deployment inputs, the one-job lock, actor cleanliness, accepted snapshot equality, row counts, and whether the full verifier inputs are present. A missing full-verifier input makes preflight exit non-zero rather than bypassing it.

## Real destructive audit delivery, dry-run containment

Runtime prerequisites at the exact target deployment:

```dotenv
DISCORD_GUILD_ID=1545644954272137297
TWO_OWEN_USER_ID=1469137636663758888
TWO_ANTI_NUKE=1
TWO_ANTI_NUKE_DRY_RUN=1
TWO_ANTI_NUKE_SNAPSHOT_PATH=<the accepted snapshot>
```

The actor application ID must not be in `TWO_ANTI_NUKE_PROTECTED_USER_IDS` or `TWO_ANTI_NUKE_TRUSTED_USER_IDS`. Keep the configured heat threshold/window unchanged.

```bash
npm run staging:anti-nuke -- \
  drive \
  --expect dry_run \
  --snapshot "$ACCEPTED_SNAPSHOT" \
  --manifest "$RUN_DIR/manifest.json" \
  --output "$RUN_DIR/gateway-dry-run.json" \
  --apply
```

The bounded scenario is exactly two actor-executed fixture role deletions, each heat 3. Owen receives the real `GUILD_AUDIT_LOG_ENTRY_CREATE` events, persists the same Discord audit-entry IDs, and records one `dry_run` incident at heat at least 5. The driver never calls `DestructiveContainment.observe()` and never inserts evidence rows.

## Armed quarantine drill

Run this only under the existing, explicit authorization for the staging live-fire drill. Use a new run ID and wait for the disposable actor's prior five-minute cleanliness window. The accepted runtime must use:

```dotenv
TWO_ANTI_NUKE=1
TWO_ANTI_NUKE_DRY_RUN=0
```

`TWO_ONBOARDING_MODE=session` must not be active because that mode forbids role writes. No production activation is authorized.

```bash
npm run staging:anti-nuke -- \
  drive \
  --expect contained \
  --snapshot "$ACCEPTED_SNAPSHOT" \
  --manifest "$RUN_DIR/manifest.json" \
  --output "$RUN_DIR/gateway-contained.json" \
  --apply
```

The only dangerous role the actor holds is the run-created Manage Roles capability. The evidence must show that Owen removed that exact role ID. Cleanup then removes the role object and any surviving target fixture. The pre/post semantic hashes must match with zero planned restore operations.

## Interrupted-run rollback

The manifest is updated after every fixture creation and assignment. Rollback never searches by prefix and never resets the guild; it addresses only the recorded IDs and first confirms any surviving role still has the expected run-specific name.

```bash
npm run staging:anti-nuke -- \
  cleanup \
  --manifest "$RUN_DIR/manifest.json" \
  --output "$RUN_DIR/cleanup.json"
```

Rollback operations are narrowly enumerated:

1. remove the recorded capability role from the recorded actor, if still assigned;
2. delete the two recorded target roles, if still present;
3. delete the recorded capability role, if still present.

If a recorded ID now has another name, cleanup refuses rather than deleting unknown state.

## Real join observation

`JoinRiskScorer` ignores bots. A compliant gateway observation therefore uses one manually-operated, human-owned disposable account. The person keeps their credential; there is no self-bot, browser automation, or token handoff.

Use one join per command and at most two join scenarios in the acceptance window:

1. normal window observation;
2. optional operator-authorized bulk-window observation.

Immediately before the person joins, record a fresh lower bound. After the member is present:

```bash
JOIN_SINCE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" # capture before the manual join
# The person now joins TWO Staging without automation.

npm run staging:anti-nuke -- \
  verify-join \
  --member-id "<joined member id>" \
  --since "$JOIN_SINCE" \
  --expect-bulk-window false \
  --expect-flagged true \
  --output "$RUN_DIR/join-normal.json"
```

Set the expected booleans before reading the result. For a bulk-window scenario, use a separately authorized runtime window and a new run ID, then expect `bulk_join_window=true` and `flagged=false`. The driver does not set the bulk window, thresholds, protected IDs, trusted IDs, roles, moderation state, or any other runtime control.

A PASS requires all three observations to share the exact member and joined-at identity:

- the real Discord guild member returned by Discord;
- the durable `member_join` row;
- the durable `join_risk_flags` row whose event ID is `guild:member:joined_at`.

The join verifier performs zero Discord writes. The source-level exact-target review remains the evidence that scoring is flag-only; the gateway-correlated row is not mislabeled as proof of a mutation.

## Final verifier and evidence package

From the exact target checkout, after all required controlled scenarios:

```bash
node "$TARGET_DIR/scripts/staging-doctor.ts"
node "$TARGET_DIR/scripts/staging-verify.ts" | tee "$RUN_DIR/staging-verify.txt"
```

Do not run `staging-reset.ts` as cleanup for this acceptance. It checks or replaces funnel fixtures and is not a containment rollback.

Register these artifacts together:

- deployment evidence naming exact SHA `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90`;
- reviewed driver commit and this runbook;
- `preflight.json`;
- `manifest.json` and any `cleanup.json`;
- `gateway-dry-run.json` and, when separately authorized, `gateway-contained.json`;
- real join evidence JSON, or a precise note that a compliant human actor was unavailable;
- `staging-verify.txt` with its real exit code;
- accepted snapshot reference and semantic pre/post hashes.

Only `classification: real_gateway_audit_receipt` is destructive gateway evidence. Only `classification: real_gateway_join_correlated` is a real join observation. `classification: unproven`, injected rows, direct observer calls, or a throwing Discord stub are not substitutes.

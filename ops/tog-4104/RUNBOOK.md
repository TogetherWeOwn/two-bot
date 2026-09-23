# TOG-4104 staging proof — operator runbook (staging only)

Execution owner: the operator, on [TOG-3706](/TOG/issues/TOG-3706). This packet
is preparation + offline verification only. No agent executes on the host.

## 0. Identity pins (fail closed)

- Staging app: `uy4d9ndeygjcem6lgayhxgub`
- Staging guild: `1545644954272137297` (`TWO Staging`)
- Accepted runtime revision: `f5fd3e1d6d08847589d3bf48ebc0b0e198196e90`
  (live image `uy4d9ndeygjcem6lgayhxgub_bot:f5fd3e1…`, measured 02:17Z)
- Proof source: this branch at its reviewed head (record the head SHA below).
- Proof key pair: `TWO_RAID_JOIN_THRESHOLD` + `TWO_RAID_WINDOW_SECONDS`
  (both `hot` AND `HOT_WIRED`, both consumed live through `liveCfg` thunks).

Source-identity basis (all commands run against the two-bot mirror):

```
git cat-file -t f5fd3e1d6d08847589d3bf48ebc0b0e198196e90   # commit
git merge-base f5fd3e1… 910c91c5…                          # 2899c29 (sibling fork)
git rev-parse 910c91c5:src/internal/actions.ts f5fd3e1:src/internal/actions.ts
  # both f6ce4baf… (identical)
for f in src/internal/*.ts src/core/settings.ts src/staging/spec.ts \
  migrations/0026_guild_settings.sql migrations/0027_guild_settings_env_only.sql \
  migrations/0002_internal_actions.sql Dockerfile; do
  echo "$f $(git rev-parse 910c91c5:$f) $(git rev-parse f5fd3e1:$f)"
done
  # all SAME except docs/INTERNAL_ACTIONS.md (changelog prose only) and the
  # 43-file TOG-3471 temp-voice + TOG-3536-era delta listed in the packet
```

The runtime equivalence claim is BOUNDED, not full: the settings wire path
(handler, server, signing, bind, store, config gates, migrations, audit
schema, Dockerfile) is byte-identical between the live image and the
reviewed merge; the catalog/config/index delta moves only which keys are
hot-wired (raid pair wired at both; landing/automod pair wired only at the
reviewed merge) and adds staging-only temp-voice. The proof key pair is
wired at BOTH, so the proof exercises the same code live as reviewed.
`event.cancel` exists on current main but NOT at the live revision; the
probe does not touch it. Build identity beyond the Dockerfile blob (base
image digests, `npm ci` layer) is not pinned - the operator's image-revision
check is the enforcement point.

## 1. Preconditions (operator verifies, no writes)

```sh
docker ps --filter "name=uy4d9ndeygjcem6lgayhxgub" --format '{{.Names}} {{.Image}} {{.Status}}'
# exactly one row; image contains f5fd3e1d6d08847589d3bf48ebc0b0e198196e90; Status Up
docker exec -i <container> sh -c \
  'test "${TWO_INTERNAL_ACTIONS:-}" = 1 && test "${TWO_INTERNAL_ALLOW_SETTINGS:-}" = 1 && echo FLAGS-OK'
docker exec -i <container> sh -c \
  'test -n "${TWO_INTERNAL_KEYS:-}" && echo KEYS-PRESENT'
# presence only: never print TWO_INTERNAL_KEYS or any signature/value
docker exec -i <container> sh -c \
  'test "${DISCORD_GUILD_ID:-}" = 1545644954272137297 && echo GUILD-OK'
```

Do NOT rewrite flags, restart, redeploy, or provision another database: both
flags are already 1 and the key is already present (02:17Z receipt).

## 2. Copy in and run (single-quoted host-side; container env never expands locally)

```sh
mapfile -t N < <(docker ps --filter "name=uy4d9ndeygjcem6lgayhxgub" --format '{{.Names}}')
[ ${#N[@]} -eq 1 ] || exit 1
C="${N[0]}"
docker cp ops/tog-4104/settings-signed-proof.mjs "$C:/tmp/settings-proof.mjs"
docker exec -i "$C" sh -c 'node /tmp/settings-proof.mjs'
```

Expected: `{"verdict":"PROOF PASS",…}` and exit 0.

- `PROOF PASS` requires the round-trip AND the pre-state restore verified by
  readback. Anything else is not acceptance.
- `REFUSED` (exit 2) = preflight: wrong app/guild/endpoint/keys/flags.
  Nothing was mutated. Fix the invocation, not the bot.
- `PROOF FAIL` (exit 1) = stop. Follow §4 before retrying.

## 3. Value-blind stored-state recovery

The probe fails closed (`cleanup.stored-needs-audit-restore`) when the key
was stored before the run, because the endpoint never returns values and the
probe never holds them. Restore from the append-only audit trail WITHOUT
displaying the value:

```sql
-- 1. confirm what the probe did (presence only, no values):
SELECT key, old_value IS NULL AS was_absent, new_value IS NULL AS removed,
       actor, at
  FROM guild_settings_audit
 WHERE guild_id = '1545644954272137297'
   AND key IN ('TWO_RAID_JOIN_THRESHOLD', 'TWO_RAID_WINDOW_SECONDS')
 ORDER BY at DESC LIMIT 6;
-- 2. write back the pre-run value WITHOUT selecting it to the terminal
--    (psql \set QUIET / redirect to /dev/null; verify by presence only):
UPDATE guild_settings AS g
   SET value = (SELECT old_value FROM guild_settings_audit
                 WHERE guild_id = '1545644954272137297' AND key = g.key
                 ORDER BY at DESC LIMIT 1),
       updated_by = '900000000000009999'
 WHERE guild_id = '1545644954272137297'
   AND key IN ('TWO_RAID_JOIN_THRESHOLD', 'TWO_RAID_WINDOW_SECONDS');
-- 3. readback by presence/source, never by value:
--    settings.get must answer source:"store" again for a restored key,
--    source:"unset" for a key absent before the run.
```

If the audit row shows the key was absent before the run, the correct restore
is `settings.set key value:null` (hands it back to the environment), then a
`settings.get` readback of `source:"unset"`.

Concurrent-writer guard: if two pre-state reads disagree, or the audit shows
an actor other than the probe between capture and restore, STOP and reconcile
with that writer before touching the key. Interrupted run: the audit trail
(`actor = 900000000000009999`) names exactly which keys the probe touched;
restore each per above, then re-run the readback.

## 4. Rollback (leaves no new surface)

No flag, secret, permission, or deployment change is part of this packet, so
there is nothing to roll back except a stored row the probe may have left:

- Key absent before the run: `settings.set` with `value:null`, readback
  `source:"unset"`.
- Key stored before the run: value-blind audit restore per §3, readback
  `source:"store"`.

Do NOT clear flags on rollback: they were already 1 before this packet and
stay 1. Do NOT redeploy, restart, or touch the mirror.

## 5. Redacted receipt (post back to TOG-3706)

Post the probe's single JSON line plus:

```
runtime: f5fd3e1d6d08847589d3bf48ebc0b0e198196e90
proof-head: <this branch's reviewed head SHA>
preState: { hadRow: <bool>, mateHadRow: <bool> }
negative: env-only 403 / tampered-body 401 / tampered-sig 401 / unknown-key 401
cleanup: <unset+verified | audit-restored+verified>
```

Shapes only - never values, keys, or signatures.

## 6. Known acceptance gaps (not closed by this packet)

- HMAC 401 is NOT a website non-admin denial proof. That needs the website
  contract suite against the staging website role, not this probe.
- The 15s settings poll means a stored value lands within ~15s, not
  instantly; the readback in this probe already accounts for it (direct
  `settings.get`, not the poll), but a dashboard clicker sees poll latency.
- Response-loss between commit and reply is handled as FAIL + audit
  reconcile, not as auto-retry: a retry with a fresh idempotency key would
  double-write. The runbook owns the reconcile.

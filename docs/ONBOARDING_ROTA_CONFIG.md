# Onboarding rota configuration contract

TOG-3531: boot-time configuration for the separately reviewed measurement core
(PR #150). **The loader has no runtime caller yet.** Merging this slice neither
collects member activity nor posts notices, and does not complete staging
acceptance. This PR is independent of #150; migration 0029 adds a settings
constraint without changing #150's migration 0028 or its review head.

## Controls

`loadOnboardingRotaConfig()` in `src/analytics/onboardingRotaConfig.ts` accepts an
explicit environment for tests and defaults to the process environment at boot.
Only the exact string `1` opts in, matching the existing feature loaders.

| Input | Default / requirement |
| --- | --- |
| `TWO_ONBOARDING_ROTA_MEASUREMENT` | Off. Master rollback suppresses notice too and returns before reading any key or validating destinations. |
| `TWO_ONBOARDING_ROTA_NOTICE` | Off. Measurement may remain enabled with notices off. A stale notice flag cannot override the measurement kill switch. |
| `DISCORD_GUILD_ID` | When enabled, a 17–20 digit id matching `DISCORD_STAGING_GUILD_ID`; the live TWO guild is always refused, even if set as staging. |
| `TWO_ONBOARDING_ROTA_PSEUDONYM_KEY` | When enabled, dedicated UTF-8 HMAC key of at least 32 bytes, not all whitespace. Use a securely generated key; the length check does not establish entropy. |
| `DISCORD_STAFF_ALERT_CHANNEL_ID` | Required valid id only when notices are enabled. No member-facing fallback. |

Prefer the systemd credential `onboarding_rota_pseudonym_key` over the environment
key. The existing credential reader controls precedence and normalization. Do
not log the returned config, key, or environment. Do not reuse a Discord token or
moderation signing key as the pseudonym key. Key deletion/rotation is outside
this configuration change and requires the existing credential decision path.

Both switches and the pseudonym key are **env-only**, not dashboard controls:
settings writes must not enable this collection or redirect the credential.
The catalog, store-first filter and migration 0029 enforce that boundary.
The existing 0027 constraint is preserved. No new table, dependency, surface or
research-survey store is added.

## Required runtime integration (not implemented here)

The eventual caller must:

1. Pass enabled/key to the existing rota service; never construct a collector
   when disabled. Keep the accepted roleless welcome flow unchanged.
2. Record observed screening clearance and successful prompt delivery, not
   inferred delivery from config; preserve core eligibility/exclusion rules.
3. Persist the first-message deadline and primary acknowledgement. A notice is
   due only after **30 minutes without a human reply or primary acknowledgement**
   (accepted TOG-2347 coverage binding, revision 3). This is not an immediate
   first-message ping. The published coverage block is America/Chicago
   18:00–22:00 daily; the 24-hour human-reply target remains human-owned.
4. Before every send, verify the actual guild and channel permissions against
   Discord: staff-only updates-and-changes, never a member-facing channel, DM or
   conversational reply. A syntactically valid configured id is **not** proof
   of private visibility. Do not silently fall back to another destination.
5. Use a bot-labeled, non-conversational notice. The notice never counts as the
   first human reply. No raw member handles in the durable rota facts.
6. Demonstrate seven milestones, notice eligibility/delivery, and both rollback
   modes in staging before requesting any separate live-release change.

## Rollback once wired

- Stop notices only: set `TWO_ONBOARDING_ROTA_NOTICE=0`, restart the bot, and verify
  the sender stays off while measurement remains enabled.
- Stop both: set `TWO_ONBOARDING_ROTA_MEASUREMENT=0`, restart, and verify no rota
  writes or sends. A stale notice opt-in or unreadable key must not prevent this.
- Do not change `TWO_ONBOARDING_MODE`, erase facts, or drop the protective settings
  constraint to roll back. Existing TOG-1644 behavior remains the accepted flow.

These are a tested loader contract, **not** a claim that restart/rollback has
already been exercised against a running Discord bot.

## Verification

```sh
npm run typecheck
TWO_TEST_DATABASE_URL=postgres://... node --test \
  test/unit.onboardingrotaconfig.test.ts \
  test/unit.settingscatalog.test.ts \
  test/unit.settingsstore.test.ts \
  test/unit.credentials.test.ts
```

The fixtures prove disabled-by-default, master and notice-only rollback, staging
identity refusal (including live-as-staging), credential precedence and key
validation, catalog drift checks, settings-store bypass protection and raw SQL
refusal of all three rota keys. They are local fixtures, not Discord staging
proof. Full repository regression uses `TWO_TEST_DATABASE_URL=... npm test`.

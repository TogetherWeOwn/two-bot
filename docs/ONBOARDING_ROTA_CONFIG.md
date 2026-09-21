# Onboarding rota configuration contract

TOG-3531: boot-time configuration for the measurement core (PR #150), introduced
independently in PR #151. The runtime integration now calls this loader at boot
and constructs the observer only when measurement is explicitly enabled. It
changes no deployment configuration and does not complete staging acceptance.
Migration 0029 adds a settings constraint without changing migration 0028.

**Notices are not implemented yet.** Boot refuses measurement-on plus notice-on
rather than silently accepting an unwired sender. Measurement-on/notice-off is
supported, and master-off still overrides a stale notice flag. See the
[runtime observations and remaining gates](ONBOARDING_ROTA.md).

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
| `TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID` | Optional explicit accepted primary binding, 17–20 digits when set. Enables the authenticated, ephemeral acknowledgement command only while measurement is on. No owner/staff inference. Unset to omit command publication/input. Master-off ignores stale values. |

Prefer the systemd credential `onboarding_rota_pseudonym_key` over the environment
key. The existing credential reader controls precedence and normalization. Do
not log the returned config, key, or environment. Do not reuse a Discord token or
moderation signing key as the pseudonym key. Key deletion/rotation is outside
this configuration change and requires the existing credential decision path.

Both switches, the pseudonym key and primary binding are **env-only**, not
dashboard controls: settings writes must not enable collection, redirect the
credential or grant primary acknowledgement to another identity. The catalog,
store-first filter and migrations 0029/0031 enforce that boundary, including raw
SQL refusal. Earlier migrations remain unchanged. No new table, dependency or
research-survey store is added; the optional command uses the existing registry.

## Runtime integration and remaining release work

Implemented: the boot caller passes enabled/key to the existing rota service,
never constructs the observer when disabled, and preserves the roleless flow.
The gateway observes screening and successful existing prompt delivery rather
than inferring them from configuration, with the core classifier unchanged.

Still required:

1. Wire the read-only deadline query into a durable delivery/claim path. The
   core derives the deadline from the persisted first message and retains primary
   acknowledgements in the existing fact log. The authenticated command is wired
   when the primary binding is configured, but no deployment binding has been
   changed or staging acceptance performed by these tests. A notice is
   due only after **30 minutes without a human reply or primary acknowledgement**
   (accepted TOG-2347 coverage binding, revision 3). This is not an immediate
   first-message ping. The published coverage block is America/Chicago
   18:00–22:00 daily; the 24-hour human-reply target remains human-owned.
2. Before every send, verify the actual guild and channel permissions against
   Discord: staff-only updates-and-changes, never a member-facing channel, DM or
   conversational reply. A syntactically valid configured id is **not** proof
   of private visibility. Do not silently fall back to another destination.
3. Use a bot-labeled, non-conversational notice. The notice never counts as the
   first human reply. No raw member handles in the durable rota facts.
4. Demonstrate seven milestones, notice eligibility/delivery, and both rollback
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
refusal of all four rota keys. They are local fixtures, not Discord staging
proof. Full repository regression uses `TWO_TEST_DATABASE_URL=... npm test`.

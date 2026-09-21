# Join → first human reply measurement

## Delivery status

The measurement core and **disabled-by-default runtime adapter** are wired in
`src/index.ts`. Observed screening, successful existing welcome sends, accepted
messages and explicit reply references feed the existing fact log. See
[configuration](ONBOARDING_ROTA_CONFIG.md) for staging-only controls.

There is still **no notice sender or scheduler**. Boot explicitly refuses
measurement-on plus notice-on until that implementation exists. This changes no
live configuration or member-facing copy. Local fixtures are not a staging
Discord demonstration and do not release the measured-evaluation gate.

The source contracts are TOG-3531 and TOG-1965's `activation-package` §4/§8.3,
with TOG-2347's accepted `coverage-binding` §3 governing the future notice.
No optional survey storage or new onboarding/event system is introduced.

## Seven milestones in the existing fact log

`community_facts` retains its existing writer, classification and idempotency
constraint. These are **derived facts**, not new raw community-scorecard streams;
they must not add active humans, messages, bot noise, or stream-coverage duties.

| Event | Observation required |
| --- | --- |
| `onboarding_rules_accepted` | An eligible, non-staff new human explicitly cleared screening. |
| `onboarding_prompt_shown` | The existing welcome was actually delivered; capture variant, delivery message ID and action destination. Configuration alone is not evidence. |
| `onboarding_prompt_acted` | First accepted message in that prompt's destination after it was shown. |
| `onboarding_first_eligible_message` | First accepted message in an allowed screened-human destination after rules acceptance, independently of prompt delivery. |
| `onboarding_first_human_reply` | A later explicit Discord reply to the qualifying action, in the same channel, by another eligible human. |
| `onboarding_reply_latency` | Atomic companion of the reply: action/reply UTC timestamps and their seconds difference. |
| `onboarding_seven_day_return` | Eligible message during `[rules accepted + 7 days, rules accepted + 8 days)`, UTC. |

The brief names six measurements while requesting seven events. The seventh is
`prompt_shown`, already required by the activation contract; it prevents treating
a configured-but-undelivered prompt as exposure. Source cohort is a property on
every event, not a fabricated seventh user action. Latency keeps both raw clocks
so reporting can recompute it rather than trust a rounded number.

Events are once per member/guild, matching the existing funnel's first-screening
semantics. Concurrent deliveries use a per-subject transaction lock and the
existing unique idempotency key. No historical timestamps are inferred. This
core consumes ordered live observations, not a history-backfill API; late older
observations do not rewrite previously emitted first milestones.

For this message-first slice, only an explicit reply reference counts. Unrelated
channel chatter does not establish a reply to the newcomer. A real human staff
primary can reply, but staff cannot enter the newcomer denominator. Bots,
webhooks, staff automation, raid/test/staging classifications, missing screening
state, rejected actions, wrong-channel and self replies are excluded. A fixture
that represents a human is not evidence that a bot is an eligible human.

## Identity and privacy

Derived `actor_id` and responder IDs are full HMAC-SHA256 pseudonyms, domain- and
guild-separated. Supply one dedicated stable key of at least 32 bytes; never use
a bot token or print the key. The core refuses an enabled instance without this
key. Provisioning and binding it are still release work, not performed by these
tests. Changing the key would fork identities and idempotency, so it is not a
routine rollback mechanism.

Source cohort is copied from verified attribution on enrollment (`unknown` when
unavailable), then remains stable on later events and redelivery. Callers must
supply only a cohort code, not free-form member text. Stored action/message and
channel IDs support the operations link; no content, handle or raw member ID is
added to the derived rows. Raw `community_facts` observations retain the existing
privacy policy. Rota-log reader authorization is the accepted primary, Community
Manager and President & COO; do not expose these rows via public views.

For an authorized erasure, compute the subject's pseudonym with the same key and
guild, then delete matching derived `actor_id` rows and rows whose metadata's
`responderId` matches. Use bound parameters; do not put a raw ID into a work
product. This is additional to the existing raw-fact/member erasure policy.

## Runtime observations

`src/discord/onboardingRota.ts` is an observer, not an alternate onboarding flow.
It sends nothing and changes no roles. It is constructed only with measurement
explicitly enabled, independently of the raw community-scorecard capture flag.

- The gateway reserves join/gate/message order before invite, funnel or automod
  I/O. Welcome observations join the same queue only after their send resolves.
  No gate is inferred from a welcome or a historical member row. An ungated join
  enrolls only if Discord advertises Rules Screening as enabled; otherwise an
  explicit `pending: true -> false` transition is required. Missing data fails
  closed. Join time is not substituted for the observed acceptance time.
- Cohort comes from the existing invite/web attribution and durable `join_source`
  projection, or `unknown`. The core freezes it on enrollment. There is no new
  join/attribution store or backfill.
- Allowed message destinations are the existing configured community human and
  welcome channel lists, plus the active session find-players destination or
  anchor room. This allowlist is boot-time. Actual ViewChannel + SendMessages
  permissions are checked for the member. Threads, DMs, system messages and
  webhooks are not qualifying sources in this slice.
- `prompt_shown` uses the actual returned message ID/time. The message-first
  action destination is session's find-players option, anchor's posted room, or
  legacy's explicitly linked intro channel (which must also be allowlisted).
  The landing/send channel is not assumed to be the action destination. Picker
  clicks, voice joins and RSVP are not counted as message-first prompt actions.
- Staff exclusions reuse moderation's protected roles and protected actor, the
  ticket staff role, guild ownership and moderation/management permissions.
  Deployments must bind their staff roles correctly. Timed-out members and
  unknown member/permission/screening state are excluded. The unchanged community
  classifier still excludes staging/test/raid/automation actors; the adapter
  does not clear exclusions to manufacture a staging activation result.
- Automod rejection **or inspection failure** cannot advance measurement. Slow
  inspection cannot let a reply overtake its action. Reply subjects are fetched
  afresh and must still be eligible; self replies and unrelated references never
  stop the clock. A human staff respondent is allowed, a staff newcomer is not.
- Observation failures are contained and emit only
  `onboarding_rota_observation_failed` / `measurement_gap`, without payloads,
  SQL binds, member IDs or secret values. The queue is not a durable gateway
  replay log: process loss can leave a measurement gap. Core milestone
  idempotency and pseudonyms survive restarts; no missed acceptance is invented.

## Durable primary acknowledgement and notice eligibility

`OnboardingRota.acknowledgePrimary()` records one `welcome_rota_acknowledged`
operations fact through `CommunityFactStore`, not a new log/table. It requires an
explicit `primaryActorId` constructor binding, an authenticated eligible human
primary, an eligible newcomer in the same guild, and the exact persisted first
message/channel. Staff status alone does not authorize an acknowledgement.
The trusted caller supplies current screening/classification evidence and a
server-observed timestamp, not values accepted from a client request body.

Acknowledgements share the existing member transaction lock and unique key,
retain the original cohort and full pseudonyms, and survive concurrent retries
and process restarts. They never emit a reply/latency fact or stop the 24-hour
human-reply clock. Notice-only rollback may still record acknowledgements;
measurement master-off cannot. The seven milestone types and raw scorecard
streams are unchanged. Migration 0030 extends the existing fact constraint and
adds a bounded deadline-query index; it does not change applied migrations.

`dueNotices(guildId, now, limit)` is a **read-only eligibility snapshot, not a send
claim**. With measurement, notice and primary binding enabled, it returns at most
100 original first-message facts at least 30 minutes old, excluding subjects
with a persisted human reply or primary acknowledgement. The deadline is derived
from the original fact timestamp, so later messages and restarts cannot reset
it. The first eligible message starts this fallback independently of prompt
exposure. No historical action or missing RSVP is manufactured.

The published coverage label is **America/Chicago 18:00–22:00 daily**, not 24/7
coverage. Elapsed deadlines remain 30 real minutes; the query does not defer or
reset them outside that block, and wider human availability remains best-effort.
An overdue candidate is not evidence of a delivered notice or a rota miss.

**Not runtime-wired:** no primary environment binding, acknowledgement command,
scheduler, delivery lease/outbox, or sender is introduced here. The constructor
binding is exercised only by tests; it is not a deployable configuration knob.
The future authenticated adapter must bind the accepted primary explicitly,
restrict rota-log access to the three authorized readers, and not infer identity
from staff permissions. A sender must recheck reply/ack state under the member
lock and use durable claim/delivery recovery before any Discord send; repeating
this read-only query alone would produce duplicate notices. Notice enablement
continues to fail closed at boot.

## Remaining integration and release gates

1. Wire the accepted **30-minute no-reply/no-acknowledgement fallback**, not
   an immediate first-message alert. Bind/authenticate primary acknowledgement,
   persist notice delivery/claim state across restarts, and recheck eligibility
   before sending. Verify staff-only effective access to the configured
   `#updates-and-changes` destination; never fall back to a human channel or DM.
   Use an explicit bot label and suppressed mentions. A notice cannot stop the
   24-hour human-reply clock.
2. Demonstrate the seven events and labeled notice in the staging environment.
   Report synthetic fixtures separately from real eligible-member observations;
   never turn off staging classification to claim real-member activation.
3. Obtain Code Reviewer verdict on the exact merge SHA, green CI, and the
   existing live-release gates. The author must not merge their own PR.

RSVP, other return-action sources and 24-hour misses must reuse the canonical
event/rota capabilities if added. Operations acknowledgements now have a durable
core API, but no authenticated runtime input; none of these is runtime-wired today. Keep missing coverage visible in any
report. Do not publish conversion success until the required sources are proven.

## Rollback

Set `TWO_ONBOARDING_ROTA_MEASUREMENT=0` and restart to omit the observer entirely,
leaving the accepted flow unchanged, without dropping facts, removing Rules
Screening or changing the roleless structure. A stale notice flag cannot override
master-off. Notices must remain off in this slice; enabling the unimplemented
sender is a boot error rather than an apparent success. Do not revert the
additive migration while derived rows exist; no data deletion is needed for
rollback. Live/staging restart proof remains a separate release requirement.

## Focused verification

Against an isolated Postgres database:

```sh
npm ci --include=dev
npm run typecheck
node --test test/unit.onboardingrota.test.ts test/unit.discordonboardingrota.test.ts \
  test/unit.rotawelcome.test.ts test/unit.rotaboot.test.ts test/unit.communityscorecard.test.ts \
  test/unit.rotanoticestate.test.ts
```

Set `TWO_TEST_DATABASE_URL` to the disposable test database before the test
command. The fixtures run real migrations and prove row counts, exclusions,
concurrent redelivery, restart identity, UTC boundaries, rollback and that the
existing community scorecard still sees zero raw activity from derived rows.

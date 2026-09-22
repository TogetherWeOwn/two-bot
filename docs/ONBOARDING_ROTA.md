# Join → first human reply measurement

## Delivery status

The measurement core and **disabled-by-default runtime adapter** are wired in
`src/index.ts`. Observed screening, successful existing welcome sends, accepted
messages and explicit reply references feed the existing fact log. See
[configuration](ONBOARDING_ROTA_CONFIG.md) for staging-only controls.

The durable notice sender and scheduler are wired in `src/index.ts`, reusing the
existing operational-audit claim machine (`src/discord/rotaNoticeDelivery.ts`,
`src/discord/rotaNoticeScheduler.ts`, `src/discord/rotaNoticePayload.ts`).
Boot refuses measurement-on plus notice-on until the channel, primary and
explicit reader bindings are all present. This changes no live configuration or
member-facing copy. Local fixtures are not a staging Discord demonstration and
do not release the measured-evaluation gate.

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
| `onboarding_first_human_reply` | A later explicit Discord reply to the persisted prompt action, in the same channel, by another eligible human. |
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
guild, then delete matching derived and operational `actor_id` rows and rows whose
metadata's `responderId` matches, including `welcome_rota_acknowledged` and
`welcome_rota_replied`. Use bound parameters; do not put a raw ID into a work
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

`OnboardingRota.reply()` also records a `welcome_rota_replied` operations fact
when another eligible human explicitly replies to the persisted first eligible
message in its channel. It shares the subject transaction lock, cohort and
pseudonymous identities; concurrent retries create one stop record. This does
not require a prompt, primary binding or notice enablement. Master-off still
refuses all writes. Migration 0033 extends the existing fact constraint without
rewriting prior migrations or backfilling unobserved replies.

This operational stop never manufactures prompt exposure, prompt action or
prompt-reply latency. If the prompt action differs from the first eligible
message, each reply is matched independently to its own action. The seven
milestones remain unchanged; neither operational fact contributes scorecard
activity or stream coverage. Existing persisted `onboarding_first_human_reply`
stop records remain honored for compatibility.

`dueNotices(guildId, now, limit)` is a **read-only eligibility snapshot, not a send
claim**. With measurement, notice and primary binding enabled, it returns at most
100 original first-message facts at least 30 minutes old, excluding subjects
with a persisted human reply or primary acknowledgement. The query joins the
existing deterministic operational-audit delivery identity to omit delivered,
quarantined and unexpired claims. Never-attempted work precedes retries, then the
oldest attempted work is retried first, so a failed or delivered early subject
cannot permanently consume a bounded batch. This is still a snapshot, not a
claim; competing workers must win the existing token-fenced claim. The deadline
is derived from the original fact timestamp, so later messages, retry ordering
and restarts cannot reset it. The first eligible message starts this fallback independently of prompt
exposure. No historical action or missing RSVP is manufactured.

The published coverage label is **America/Chicago 18:00–22:00 daily**, not 24/7
coverage. Elapsed deadlines remain 30 real minutes; the query does not defer or
reset them outside that block, and wider human availability remains best-effort.
An overdue candidate is not evidence of a delivered notice or a rota miss.

### Authenticated primary input

With staging-only measurement enabled and an explicit boot-time
`TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID`, the existing command registry publishes
`/rota-acknowledge message-link:<canonical Discord message link>`. The command is
reserved against custom-command shadowing even while disabled. It defaults to
Manage Guild visibility, but **the authenticated interaction user must match the
bound primary** regardless of Discord command-permission overrides. Staff status
or guild ownership alone cannot acknowledge for the primary. The configured
primary is also excluded as a newcomer, even without a staff role.

The adapter accepts only `https://discord.com/channels/<guild>/<channel>/<message>`
in its configured guild and screened-human channel allowlist. No arbitrary URL
is fetched. It reserves observation order before REST I/O, fetches primary and
subject members afresh, verifies known screening/roles/permissions and timeout
state, and requires a normal text channel, primary View/Send/Read History and
subject View/Send permissions. Bot/webhook/system/partial messages are refused.
The message must match the **already observed** persisted first action: reading
historical Discord messages does not enroll members or manufacture milestones.
The unchanged classifier and core exclusions run again before persistence.

Results are deferred **ephemerally**, with suppressed mentions and generic text
only—no handle, message link, subject id or rota-log listing in responses. Errors
log a fixed measurement-gap classification, never payloads or error text. There
is no public-channel or DM fallback. This interaction response is not the future
staff-only fallback notice, and does not count as a human reply.

Master-off omits both observer and command handler/publication. Removing the
primary binding omits the command without stopping measurement; the central
registry removes its previous publication on a successful sync. No binding is
inferred from another owner/admin setting. Notice-only off retains primary input.
Environment binding is a deployment responsibility; no live identity or
configuration was changed in this slice. Existing rota-log reader limits remain.

**Runtime-wired:** the 60-second non-overlapping scheduler
(`src/discord/rotaNoticeScheduler.ts`) drives `RotaNoticeDelivery`, which stores
one deterministic `rota_notice` row per subject/action in the existing
`operational_audit_log` claim machine, rechecks reply/ack state under the member
lock (`confirmNoticeEligible`), and recovers ambiguous sends through the durable
content marker instead of resending. After access/history I/O, a final
`withNoticeEligibility` check holds that same subject lock through POST, ordering
the send against concurrent persisted reply/ack writes. Access census/history
fetches occur outside that lock. The audit recovery cursor is committed before
POST; a token-fenced lease renewal immediately before POST refuses stale workers.
A database transaction/acknowledgement failure after POST remains ambiguous and
retains recovery evidence rather than causing a blind resend. Repeating the read-only query alone would
produce duplicate notices; the sender never does that. Notice enablement
continues to fail closed at boot without the full binding.

The shared store does not imply shared delivery ownership. Generic audit
`claimPending` and delivered-mirror reconciliation exclude `rota_notice` rows
**before their batch limits**; generic `record` also refuses that kind. Only the
rota sender claims those identities and understands their marker. The generic
30-second retry timer cannot send or quarantine notices while the rota scheduler
is disabled, or bypass the eligibility/reader checks. Ordinary audit work retains
its existing queue and reconciliation behavior.

Recovery scans at most five pages of 100 messages, renewing the claim before
each page and refusing renewal failure. Every page must have valid descending
snowflakes, advancing cursors, known authors and non-partial messages in the
exact guild/channel. Exactly one non-webhook bot-authored marker must be found
in a complete recovery window. Missing/duplicate markers, malformed pages or an
exhausted page budget quarantine the row without resending. New claims with no
prior POST boundary fetch only the newest cursor; they do not walk old history.
A changed durable guild/destination/action binding is quarantined, not redirected.

The operational-audit kill switch is checked after claiming and at the final
POST boundary; read errors hold delivery. Holding an ambiguous prior attempt
preserves its recovery boundary. Only a claim that knows no POST began may clear
its newly prepared boundary. Scheduler shutdown stops new ticks and prevents an
in-flight pre-POST attempt from sending. An already-dispatched POST cannot be
retracted; its durable boundary remains the recovery backstop.

### Staff-only destination access boundary

The future sender must not equate a channel name, configured snowflake, role
label, or an `@everyone` deny with private visibility. Discord's effective
permissions include member overwrites, role overwrites, Administrator and guild
ownership. The notice contains a pseudonym and action link, so an additional
reader is a disclosure even when the channel is conventionally called staff-only.

`src/discord/rotaNoticeAccess.ts` provides a **read-only, fail-closed snapshot**
for that boundary. The caller supplies the exact guild/destination and an explicit
set of authorized Discord reader identities; the helper does not infer readers
from staff roles or populate a deployment binding. Those identities must map to
the accepted primary, Community Manager and President & COO contract, not a
broader staff audience. The sending bot is the only additional permitted reader.
It force-fetches the guild, roles, normal text channel and bot member, completes
a full member fetch, and compares its size with stable before/after REST
`approximateMemberCount` values. Missing counts, count skew, unknown effective
permissions and partial/foreign member state cause refusal. The gateway-cached
`memberCount` is not treated as REST-fresh evidence. Approximate counts and a
completed fetch are consistency checks, **not atomic proof of exact membership**;
large or changing guilds may be conservatively refused. Every permitted human
must be present with View/Read History, and the bot needs View/Read History/Send.
No credentials, raw reader identities, channel payloads or API error text are
logged or persisted by the verifier. It never changes permissions or sends.
An extra administrator, owner, or other bot with access causes refusal; do not
silently widen the reader contract or rewrite guild permissions to make it pass.

This snapshot is not delivery authorization by itself. Discord permission and
membership changes are not atomic with a later send. The wired sender runs the
check immediately before each attempted send/recovery, retains the master
and notice gates, and refuses uncertain results without a fallback destination,
backed by the durable claim, lock-scoped eligibility recheck and ambiguous-send
recovery. A safe snapshot cannot establish that permissions will remain safe
afterwards; ongoing access restriction and release proof remain operational
requirements.

## Remaining integration and release gates

1. The accepted **30-minute no-reply/no-acknowledgement fallback** is wired
   (not an immediate first-message alert): notice delivery/claim state persists
   across restarts in `operational_audit_log`, the accepted primary is bound in
   the target environment, eligibility is rechecked under the member lock before
   sending, and staff-only effective access to the configured
   `#updates-and-changes` destination is verified per attempt with no human-channel
   or DM fallback. The notice carries an explicit bot label and suppressed
   mentions. A notice cannot stop the 24-hour human-reply clock.
2. Demonstrate the seven events and labeled notice in the staging environment.
   Report synthetic fixtures separately from real eligible-member observations;
   never turn off staging classification to claim real-member activation.
3. Obtain Code Reviewer verdict on the exact merge SHA, green CI, and the
   existing live-release gates. The author must not merge their own PR.

RSVP, other return-action sources and 24-hour misses must reuse the canonical
event/rota capabilities if added; those sources are not runtime-wired today.
Keep missing coverage visible in any report. Do not publish conversion success until the required sources are proven.

## Rollback

Set `TWO_ONBOARDING_ROTA_MEASUREMENT=0` and restart to omit the observer, delivery
service and scheduler entirely, leaving the accepted flow unchanged, without
dropping facts, removing Rules Screening or changing the roleless structure. A
stale notice flag cannot override master-off. Stop notices only with
`TWO_ONBOARDING_ROTA_NOTICE=0`: measurement and primary acknowledgement stay
intact while the sender and scheduler stay off. Enabling notices without the
full channel, primary and explicit reader binding is a boot error rather than an
apparent success. Do not revert the additive migrations while derived rows
exist; no data deletion is needed for rollback. Live/staging restart proof
remains a separate release requirement.

## Focused verification

The [isolated process restart harness](ROTA_PROCESS_HARNESS.md) adds real-entrypoint
local mock-Discord negative-scope evidence, a dispatch-removal mutation, and
transport containment checks. It preserves staging exclusion and does not replace
actual staging or positive notice-delivery acceptance.

Against an isolated Postgres database:

```sh
npm ci --include=dev
npm run typecheck
node --test test/unit.onboardingrota.test.ts test/unit.discordonboardingrota.test.ts \
  test/unit.rotawelcome.test.ts test/unit.rotaboot.test.ts test/unit.communityscorecard.test.ts \
  test/unit.rotanoticestate.test.ts test/unit.rotaacknowledgement.test.ts \
  test/unit.rotanoticeaccess.test.ts test/unit.rotanoticepayload.test.ts \
  test/unit.rotanoticedelivery.test.ts test/unit.rotanoticescheduler.test.ts
```

Set `TWO_TEST_DATABASE_URL` to the disposable test database before the test
command. The fixtures run real migrations and prove row counts, exclusions,
concurrent redelivery, restart identity, UTC boundaries, rollback and that the
existing community scorecard still sees zero raw activity from derived rows.

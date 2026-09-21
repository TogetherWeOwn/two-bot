# Join → first human reply measurement

## Delivery status

This change delivers the **measurement core only**. `OnboardingRota` is not yet
constructed by `src/index.ts`, no gateway handler calls it, and there is no
notice sender or scheduler. It changes no live configuration or member-facing
copy. Do not treat the fixture result as a staging Discord demonstration or
release the measured-evaluation gate yet.

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

## Remaining integration and release gates

1. Wire observed gate, successful existing welcome delivery, message, and explicit
   reply-reference paths. Resolve current screening/staff/channel access and
   automod eligibility; missing data must fail closed. Keep the accepted
   TOG-1644 onboarding behavior and TOG-1649 canonical event ownership.
2. Add environment/config controls for measurement and the notice independently,
   with measurement/notice disabled by default and classified in the settings
   catalog. `enabled: false` already proves zero core writes; it is **not** yet
   an operator-facing flag wired to the application.
3. Implement the accepted **30-minute no-reply/no-acknowledgement fallback**, not
   an immediate first-message alert. Persist acknowledgement and notice delivery
   state across restarts. Verify staff-only effective access to the configured
   `#updates-and-changes` destination; never fall back to a human channel or DM.
   Use an explicit bot label and suppressed mentions. A notice cannot stop the
   24-hour human-reply clock.
4. Demonstrate the seven events and labeled notice in the staging environment.
   Report synthetic fixtures separately from real eligible-member observations;
   never turn off staging classification to claim real-member activation.
5. Obtain Code Reviewer verdict on the exact merge SHA, green CI, and the
   existing live-release gates. The author must not merge their own PR.

RSVP, other return-action sources, 24-hour misses and operations acknowledgements
must reuse the canonical event/rota capabilities if added; this core does not
claim those are wired or measured today. Keep missing coverage visible in any
report. Do not publish conversion success until the required sources are proven.

## Rollback

This core has no application caller, so deploying it alone enables no collection
or notice. At integration, disable notice independently, or disable both
measurement and notice to return to the accepted flow without dropping stored
facts, removing Rules Screening or changing the roleless structure. Do not
revert the additive migration while derived rows exist; no data deletion is
needed for rollback.

## Focused verification

Against an isolated Postgres database:

```sh
npm ci --include=dev
npm run typecheck
node --test test/unit.onboardingrota.test.ts test/unit.communityscorecard.test.ts
```

Set `TWO_TEST_DATABASE_URL` to the disposable test database before the test
command. The fixtures run real migrations and prove row counts, exclusions,
concurrent redelivery, restart identity, UTC boundaries, rollback and that the
existing community scorecard still sees zero raw activity from derived rows.

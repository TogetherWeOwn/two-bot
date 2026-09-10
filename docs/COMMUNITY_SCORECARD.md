# Human-only weekly community scorecard

The scorecard extends the bot-owned append-only event architecture. It does not store message bodies and does not create a second analytics service.

## Schedule and reporting window

- Enable with `TWO_COMMUNITY_SCORECARD=1` after completing the configuration below.
- The in-process job checks once per minute and runs Monday at 06:15 UTC.
- It reports the immediately preceding closed ISO week: Monday 00:00 UTC inclusive through the next Monday exclusive.
- An identical `(guild, week, classifier version, watermark)` reuses the stored result and emits no duplicate threshold alert. Late facts advance the watermark and create a retained revision.

## Required configuration

```text
TWO_COMMUNITY_SCORECARD=1
TWO_COMMUNITY_RECOMMENDATIONS=1
TWO_COMMUNITY_CORRECTION_CYCLES=0
TWO_COMMUNITY_CLASSIFIER_VERSION=community-v1
TWO_COMMUNITY_HUMAN_CHANNEL_IDS=<comma-separated Discord channel ids>
TWO_COMMUNITY_WELCOME_CHANNEL_IDS=<comma-separated welcome/general channel ids>
TWO_COMMUNITY_AUTOMATION_ACTOR_IDS=<comma-separated bot/staff automation ids>
TWO_COMMUNITY_RAID_ACTOR_IDS=<comma-separated flagged account ids>
TWO_COMMUNITY_STAGING_GUILD_IDS=<comma-separated staging guild ids>
TWO_COMMUNITY_STAGING_ACTOR_IDS=<comma-separated staging actor ids>
TWO_COMMUNITY_TEST_ACTOR_IDS=<comma-separated fixture/test ids>
```

Classifier precedence is fixed: Discord bot, webhook, configured staff automation, raid, staging, test, eligible human. Changing a rule requires incrementing `TWO_COMMUNITY_CLASSIFIER_VERSION`; old scorecard revisions remain attached to their original version.

## Durable capture

`community_facts` stores content-minimized facts with guild, type, source event id, pseudonymous actor id, timestamps, classifier result/version, matched rule, compact metadata and idempotency key.

- Messages are keyed by `discord-message:<message id>` and preserve channel class, bot flag and webhook id without content.
- Voice starts and ends use a stable session key. An end with no known start is retained for reconciliation but excluded from duration totals; no duration is invented.
- Attendance accepts explicit host check-in, durable check-in, or at least 600 seconds of voice proof. RSVP-only calls return without writing an attendance fact.
- Every required stream must have either a fact in the week or a `community_stream_heartbeats` row covering through the closed boundary.

An attendance integration can call `CommunityFactStore.recordAttendance` when its accepted proof is observed. This repository's existing scheduled-event REST mirror contains event definitions, not attendance history, so the scorecard does not treat Discord RSVPs as attendance.

## Metrics and thresholds

- Weekly active: distinct eligible humans with one eligible message or at least 600 unioned voice seconds.
- Human messages: eligible `message_created` facts only.
- Eligible joins: eligible `member_joined` facts; unknown source remains unknown.
- Attendance: distinct eligible `(event occurrence, actor)` participations plus distinct humans.
- Bot noise: bot + webhook + staff automation messages divided by those messages plus eligible-human messages in configured human spaces. Zero denominator is `null`. Alert is false below 20% and true at 20%.
- First human reply: after rules acceptance when present, otherwise join; requires the joining actor's first eligible welcome/general message followed by a later eligible message from somebody else. Excluded and self replies do not stop the clock.
- Fewer than five distinct eligible humans is `insufficient` evidence. Counts remain visible; growth intervention is suppressed.

The deterministic intervention order is ingestion incomplete, bot noise high, first-reply breach, then hold. Event-at-risk and two-week decline require future durable pre-event/previous-week context and are not inferred from the current scheduled-event snapshot.

## Fail-closed checks and bail-outs

A weekly run reports `coverage_state: incomplete`, null engagement numerators, and `INGESTION_INCOMPLETE` when any of these fail:

1. required stream coverage through week end;
2. no duplicate source ids;
3. one guild and half-open week scope;
4. valid non-negative known voice durations;
5. recognized classifier result and requested version;
6. exact per-event and total reconciliation;
7. exclusion buckets, including zeros.

Do not change community programming from an incomplete scorecard. Repair capture/reconciliation first.

## Success, kill switch and undo

Success during the first 30 days means every weekly result reconciles, all six metrics are emitted, excluded facts contribute zero to human numerators, 20% bot noise alerts, and reruns do not duplicate alerts.

After two engineering correction cycles, set `TWO_COMMUNITY_CORRECTION_CYCLES=2`. If the run remains incomplete or unreconciled, recommendations and threshold notifications are disabled automatically while raw validated reporting continues. `TWO_COMMUNITY_RECOMMENDATIONS=0` is the immediate manual kill switch.

Undo:

1. set `TWO_COMMUNITY_SCORECARD=0` (or unset it) to stop the schedule and new scorecard capture wiring;
2. set `TWO_COMMUNITY_RECOMMENDATIONS=0` to stop only recommendations/alerts;
3. restart the bot using the normal deployment path;
4. retain `community_facts`, `community_scorecard_runs`, and prior alerts for audit—do not delete source facts.

## Verification

```bash
npm run typecheck
node --test test/unit.communityscorecard.test.ts
node --test test/unit.store.test.ts test/unit.voicesession.test.ts test/unit.dashboard.test.ts test/unit.joinwiring.test.ts
```

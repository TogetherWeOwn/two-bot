# Announcements / feeds / events staging proof (TOG-3845)

This is a **source-level integration proof**, not a deployment or human Discord
UI test. It runs the production internal-actions HTTP server and announcement
service/interaction listener from a clean committed checkout. It uses real
Discord REST, real staging Postgres, and one item fetched with the production
public RSS fetcher/parser. Interaction actors are synthetic; no member account
or user token is used. The deployed bot's commands/configuration are unchanged.

## Guarded run

Requirements:

- `DISCORD_STAGING_BOT_TOKEN` bound to Owen QA Test application
  `1469137636663758888`. Both token identity and remote application are checked.
- `TWO_STAGING_DATABASE_URL` bound to database **two_bot_staging**. No fallback to
  `DATABASE_URL`/`TWO_DATABASE_URL`, no routing query parameters, no public-schema
  migration. Every run creates a fresh `tog3845_ann_<24 hex characters>` schema.
- Exact guild **1545644954272137297**, named TWO Staging. An explicit mismatching
  `DISCORD_STAGING_GUILD_ID` is rejected. Live guild **326474832151838730** is never
  a selectable target.
- One staging `#bot-log` text channel; QA bot can post/read there and create/manage
  scheduled events and temporary channels. The bot must not be owner or
  Administrator: otherwise the real permission-denial case fails preflight.
- Clean checkout and dependencies installed. The report pins `git rev-parse HEAD`.

Run with the already-bound environment; never paste credentials into commands:

```sh
node scripts/staging-announcements-proof.ts --output="$PAPERCLIP_RUN_SCRATCH_DIR/announcements-proof.json"
node scripts/staging-verify.ts --case=announcements --proof="$PAPERCLIP_RUN_SCRATCH_DIR/announcements-proof.json"
```

The report path must be new (exclusive creation). Upload the JSON/report to the
issue before run scratch expires. A nonzero exit, missing check, failed cleanup,
or failed readback is **not proven**. Do not relabel an interrupted run as a pass.
The targeted verifier is read-only, opens a read-only SQL transaction without
migrating, rechecks remote identities, cancelled event, durable audit/mapping,
empty active tables, and 404s for the owned deleted messages/channel. It does not
rerun writes and does not replace the independent exact-SHA review.

The proof transport honors explicit Discord 429 `retry_after` responses with
at most two retries and a 30-second maximum advertised delay, still bounded by
the caller's 15-second timeout. It never retries network/5xx errors or permission
denials. The proof sets the internal client's content timeout to 15 seconds.
These are proof-only transport settings, not changes to production retry policy.

## Coverage and limitations

- Signed announcement posting, content readback, idempotency replay, unknown
  channel refusal; real Discord SendMessages denial in a newly created private
  proof channel. No existing channel overwrites or shared roles are edited.
- Signed event create, update of the same mapped identity, status-4 cancellation,
  readbacks, unknown-key refusal, and replay after restarting the local endpoint.
  The same durable store is reused. This is not a deployed-process restart test.
- Synthetic `/rsvp` and LFG select interactions pass through the production
  listener. Repeats leave one RSVP/signup row; RSVP changes and LFG slot moves,
  capacity denial, closure and removed controls are checked. Repeated signup/RSVP
  can still produce edits/audit rows; zero writes is not the claimed invariant.
- Synthetic member masks exercise ManageGuild/ManageEvents refusals in the real
  listener, separately from the **real** Discord channel permission refusal.
- A real NASA RSS snapshot is bounded to one item, annotated with the proof
  marker, then fed twice through the production polling/delivery code. One
  delivered row/message, unknown-feed refusal, removal and no subsequent
  delivery are checked. This proves follow/poll deduplication, not a timed
  deployed poller, every feed kind, or a newly published upstream item.
- Existing audit tables are queried for this isolated run. No mock 403 or old
  unrelated audit row is substituted for staging evidence.
- Hierarchy is **not applicable** to these operations: LFG slot labels do not
  assign Discord member roles. Owner/admin bypass is not counted as permission
  proof. Other slices own actual role-hierarchy tests.
- RSVP validates each snowflake-shaped event ID with Discord's live scheduled
  event endpoint before writing. The proof checks that a missing event (404) and
  the run's cancelled event are both refused without changing RSVP/audit state.
- Scheduled-event updates/cancellation change that Discord event. There is no
  claim that previously posted announcement text is automatically rewritten,
  that followers get an additional notification, or that LFG closure is wired
  automatically to scheduled-event cancellation.

## Feed failure modes (SSRF guard, redirects, timeouts)

Production feed fetching (`src/announcements/feedHttp.ts`, read through
`XmlFeedReader` in `src/announcements/discord.ts`) fails closed in three ways
the staging proof above does not directly exercise:

- **SSRF guard.** Before connecting, the fetcher resolves the feed hostname
  and requires *every* resolved address to be a public IP
  (`assertPublicHostname`, `createPublicLookup`). Private, loopback,
  link-local, carrier-grade NAT, documentation, and multicast ranges (IPv4
  and IPv6) are rejected, including IP literals. Enforcement happens twice:
  a pre-flight check plus a custom undici connector, so a DNS change between
  check and connect (rebinding) still cannot reach an internal address.
  Rejection errors: `Feed source must resolve only to public IP addresses.`
  (pre-flight) or `Feed source resolved to a non-public IP address.`
  (connect-time).
- **Redirects refused.** The fetcher passes `redirect: 'error'`, so any 3xx
  response rejects the fetch instead of following it — including redirects
  that would land on an internal address past the SSRF check. Like every
  other fetch failure, this is caught per-feed in `pollFeeds`
  (`src/announcements/service.ts`): no message is posted, remaining feeds
  still poll, and the failure is audited.
- **Service-layer timeout.** `pollFeeds` sets no deadline of its own; each
  feed read is bounded by a 15-second `AbortSignal.timeout` at the reader
  layer (`REQUEST_TIMEOUT_MS` in `src/announcements/discord.ts`). A hung
  feed aborts at 15 s, records a failed poll, and the loop moves on — worst
  case roughly 15 s per feed, sequential. There is no fetch retry in the
  service layer; the next scheduled poll tries again.

**What the operator sees in audit.** Every poll writes one
`announcement_audit` row per feed with `action = 'feed.poll'`,
`actor_id = NULL` (system poll), and the feed id as target. Success rows
carry `outcome = 'read N'`; failure rows carry `outcome = 'failed'` with
`reason` set to the first 500 characters of the error (SSRF rejection,
redirect error, timeout abort, HTTP status, oversize feed, or unsupported
content type). A feed that never shows a `read N` row but accumulates
`failed` rows is misconfigured or unreachable — check `reason` before
touching delivery state; undelivered items stay claimable for the next poll.

## Ownership and cleanup

A random run marker tags every created Discord artifact. Cleanup inspects
ownership before deletion and does not delete messages from another author or
messages whose marker changed. It removes only the run's messages, private
denied-send channel, feed configuration/delivery, LFG/signups, and synthetic RSVP.
On a partial failure it inventories the marker's artifacts before cleanup;
ambiguous inventories fail instead of deleting arbitrary objects. Audit rows,
idempotency records, and the mapped **cancelled scheduled event** are retained
intentionally for independent verification. Cleanup ensures that event is
terminal; it does not delete/forget its identity. Retained evidence schemas are
not active bot schemas and have no background poller.

Never drop another run's schema or remove retained event evidence as an ad-hoc
cleanup. Record failed report IDs and inspect before a separately authorized
repair. Do not enable `TWO_INTERNAL_ALLOW_EVENT_CANCEL` on a deployed/live bot
as part of this script. Final acceptance still needs exact-head CI, independent
code/security verdicts, independent merge, deployment evidence and the authorized
TOG-1313 matrix update.

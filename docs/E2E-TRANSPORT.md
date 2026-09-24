# Staging transport contract and live-proof boundary

TOG-4122 delivers code, **not account readiness or a staging PASS**. Parent
TOG-3978 / QA owns the first authorized live execution after TOG-3987 supplies
the one ordinary-member account and its runtime vault binding. No live account,
login, credential fetch, guild join, or Discord test was used to develop this
adapter. Do not schedule this CLI in CI, cron, or a retry loop.

## Why a native client

The repository requires Node >=24. Node's browser-compatible `WebSocket` is
stable since 22.4; native `fetch` and `AbortSignal` provide the HTTP boundary.
There is **no added package**, selfbot library, browser driver, fingerprint,
cookie store, CAPTCHA solver, login flow, or reconnect machinery. Client
properties identify the tool honestly as `two-staging-e2e`.

- Node APIs: https://nodejs.org/docs/latest-v24.x/api/globals.html#class-websocket
  and https://nodejs.org/docs/latest-v24.x/api/globals.html#fetch
- Gateway lifecycle: https://docs.discord.com/developers/topics/gateway
- Gateway event/opcode shapes:
  https://docs.discord.com/developers/events/gateway-events

The official Discord developer docs describe bot applications, not a supported
user-account automation SDK. The user-only endpoints below remain unofficial
and can drift or be refused by Discord. Owner acceptance of the staging account
risk is not a Discord exemption. A challenge or refusal is terminal: do not add
spoofing, solve challenges, widen permissions, or silently retry to make it pass.

## Source-backed user protocol, not a dependency

For the component envelope and ephemeral path, source inspection used
`aiko-chan-ai/discord.js-selfbot-v13` at immutable commit
`bf38318902cea8d0110d638e1dfadc01aec6b7cc`. That library is **not installed or
executed**. These source URLs are protocol evidence, not an endorsement of its
defaults (which include unrelated subscriptions, retries, and desktop properties).

- [Message.js:1100–1123](https://github.com/aiko-chan-ai/discord.js-selfbot-v13/blob/bf38318902cea8d0110d638e1dfadc01aec6b7cc/src/structures/Message.js#L1100-L1123):
  component invocation sends `type:3`, `nonce`, `guild_id`, `channel_id`,
  `message_id`, `application_id`, READY's `session_id`, `message_flags`, and
  `data:{component_type:2,custom_id}` to `POST /interactions`.
- [Options.js:223–234](https://github.com/aiko-chan-ai/discord.js-selfbot-v13/blob/bf38318902cea8d0110d638e1dfadc01aec6b7cc/src/util/Options.js#L223-L234):
  the inspected user client targets API v9. This adapter pins its two origins to
  `https://discord.com/api/v9` and `wss://gateway.discord.gg/?v=9&encoding=json`;
  the CLI accepts no endpoint overrides or server-provided resume URL.
- [Util.js:925–963](https://github.com/aiko-chan-ai/discord.js-selfbot-v13/blob/bf38318902cea8d0110d638e1dfadc01aec6b7cc/src/util/Util.js#L925-L963):
  reply waiter matches `MESSAGE_CREATE` by nonce. `INTERACTION_SUCCESS` is a
  distinct defer-update completion; it does **not** prove reply content.
- [MessageCreate.js](https://github.com/aiko-chan-ai/discord.js-selfbot-v13/blob/bf38318902cea8d0110d638e1dfadc01aec6b7cc/src/client/actions/MessageCreate.js)
  and [MessageFlags.js:45–60](https://github.com/aiko-chan-ai/discord.js-selfbot-v13/blob/bf38318902cea8d0110d638e1dfadc01aec6b7cc/src/util/MessageFlags.js#L45-L60):
  ephemeral is bit 64, loading is bit 128. Deferred replies may produce an initial
  loading message followed by a message update.
- Membership screening has no official user-client contract. Secondary,
  **unofficial** reference:
  https://docs.discord.food/resources/guild#get-guild-member-verification and
  https://docs.discord.food/resources/guild#create-guild-join-request .
  The adapter first proves the account is **already a member**; it does not join
  via invites. It handles only a nonempty, versioned TERMS-only verification form
  and submits its responses. Other forms return 501 and stop without submitting.
  This shape still needs live validation; no bypass or administrative approval
  endpoint is implemented.

## Enforcement and normalization

`DiscordHarnessTransport.connect` validates the pinned staging guild and all
configured snowflakes before reading Discord. `GET /users/@me` must match the
configured account and must not be a bot. Current guild membership and role
permissions must be readable. The configured ticket STAFF role must exist but
must not be held; elevated administrative/moderation permissions are refused.
Applicable channel-level privilege grants are also refused conservatively, even
if a later deny could neutralize one. Permission drift fails closed.

Every mutating method refreshes role permissions and membership, uses a private guard (>=2 s plus
0–1499 ms jitter, nine message actions and thirty total actions), and validates
the action's target. The flow guard additionally paces observations and records
the transcript. HTTP reads used for validation are not writes; heartbeats are
protocol maintenance, not simulated user actions. Nothing retries a failed HTTP
request: **any** non-2xx response stops the connection, especially 401/403/429.
Redirects fail. Error bodies and library exceptions are never logged or returned;
only safe status codes cross the transport boundary. Requests have a 15-second
bound and are aborted on shutdown. The wire holds the credential in private
fields, clears its reference on close, and never stores it on a session or in
transcripts. This is not a promise of cryptographic memory erasure in JavaScript.

One gateway connection identifies once. Listeners are attached before Identify
and remain active during pacing and waits. Hello starts jittered heartbeats;
missed ACK, invalid session, reconnect request, transport error, or close ends
the run without reconnect/resume. `session.close()` closes the transport and
releases the process singleton; operators must not start concurrent CLI processes.

Only normalized events needed by the flows enter the inbox:

| Wire packet | DTO / eligibility |
|---|---|
| `GUILD_MEMBER_UPDATE` | `guildMemberUpdate`: staging, configured account, ordinary roles |
| `CHANNEL_CREATE` | `channelCreate`: staging; ticket only after Open, text type, `two-ticket:` topic and explicit account ViewChannel overwrite; voice only after lobby join, voice type and explicit account ViewChannel overwrite |
| `CHANNEL_DELETE` | `channelDelete`: known validated staging channel |
| `VOICE_STATE_UPDATE` | `voiceStateUpdate`: configured account, staging, null or known voice channel |
| `MESSAGE_CREATE` | `messageCreate`: known text channel, actual id/author/content/flags/components |
| `MESSAGE_UPDATE` | Same message DTO only when merging into a previously observed message; cannot invent the missing author/channel |

An ephemeral message additionally needs a nonce issued by this connection.
Updates retain that nonce from the original message. Unrelated nonces are dropped.
Exact duplicate normalized message revisions are ignored. REST 204 and
`INTERACTION_SUCCESS` **never** synthesize a message. The expected application is
the configured ticket bot; Open uses a fetched panel with the observed button,
while Claim/Close require the observed controls in the newly discovered ticket.

The inbox preserves unmatched events, removes only the first matching event, and
supports both early and later arrivals. Timeout returns 504; cancellation returns
499 without exposing an abort reason. Close/disconnect settles pending waits and
prevents further writes. Storage is bounded at 256 events / message revisions;
overflow fails closed rather than silently evicting proof. Assertions have a
maximum timeout of 60 seconds.

## What the offline tests establish

`test/unit.e2etransport.test.ts` drives a fake fetch/WebSocket boundary rather than
pre-scripting flow results. It checks emitted requests and injects wire packets:

- Early, during-pacing and after-wait events; FIFO consume-once and unmatched
  retention; cancellation, timeout, close, disconnect, buffer bound.
- Wrong guild/account, bot/staff/admin, target/channel drift, unauthorized
  discovery, unsupported verbs/forms; no write follows a refusal.
- Exactly one request for terminal 401/403/429; no raw exception/body in results.
- Exact component envelope, correlated ephemeral/loading/update delivery, no
  synthetic success, voice opcode and event mapping, direct-call pacing/budgets.
- Credential-free dry-run and live configuration refusal before network access.

The existing guard/flow suites retain strict successful Claim semantics. A
`ticket-open-denial` result covers only an ordinary member opening a ticket and
receiving staff-only refusals, with a staff cleanup handoff. The successful
`ticket-buttons` staff Claim/Close sequence remains ineligible for a live
ordinary-member run. No flow result here discharges all of TOG-3690.

## Required parent QA evidence / residuals

1. Account ready, runtime vault binding, staging-only membership/role inventory;
   no account or credential readiness is implied by this PR.
2. A real READY on the minimal honest Identify; official docs do not guarantee
   these user-account semantics. No guild subscription opcode is emitted: if
   member events require an undocumented subscription, stop and report the gap
   rather than substituting a REST snapshot for a gateway outcome.
3. Real nonce-correlated ephemeral reply delivery, including deferred updates and
   an event arriving while the >=2-second flow guard sleeps. The pinned client
   source plus fake packets establish the mapping, **not** live delivery today.
4. Real screening TERMS version and responses; reject unsupported forms. Voice
   signaling is gateway-only, muted/deafened, no audio/media connection; QA must
   verify that the bot sees the move and that the owned spawn has the required
   overwrite. If not, record unsupported live behavior, not PASS.
5. Record the created ticket id and hand it to authorized staff for cleanup even
   after a later denial/timeout. The ordinary member cannot safely close it, and
   the harness must not elevate them. Successful staff Claim/Close stays residual.
6. Preserve emergency kick via the separately provisioned **bot** token and the
   explicit credential-rotation requirement. This child never executes either.

Only real staging gateway evidence may support parent acceptance. Green offline
contracts, a merged PR, a dry run, or an all-skipped transcript cannot do so.

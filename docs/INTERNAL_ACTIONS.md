# The internal actions endpoint

**Status: `v0.4` — the endpoint is complete and tested (TOG-44), and join
attribution for one-click joins is built (TOG-464). Nothing on this page is
specification any more.**

All four allowlisted actions are built. Three are live by default —
`role.assign`, `announcement.post`, `event.upsert` — and `guild.add_member`
is built and tested but switched off until the CEO signs off (§3).

The pieces that were waiting on Postgres landed with TOG-37 and are now in
`src/internal/store.ts` and `migrations/0002_internal_actions.sql`: the durable
`idempotency_key → result` store, the durable audit trail, and a replay guard
that is a table rather than a process's memory. **The restart-reopens-a-replay-
window limit described in earlier revisions of this document no longer
applies.**

Join attribution for one-click joins (§7) landed with TOG-464 — every part of
this page is now built.

The wire format below is what is implemented. If something here is wrong for
the caller, say so on TOG-44.

The website never holds the Discord bot token. When it needs something to
happen in the TWO server, it calls **one** endpoint on the bot, over the
private network, with an HMAC signature, naming an action from a **fixed
allowlist**. The bot decides whether to do it.

That is the entire trust model. It survives the website being compromised: an
attacker with the website's shared secret can do exactly the things on the
allowlist, at the rate limit, and nothing else. They cannot read the guild,
cannot kick, cannot ban, cannot change permissions, because there is no verb
for it here.

**The allowlist does not widen without the CEO's sign-off.** That is not my
call to make and it is written into TOG-44. A new action means a comment on
TOG-44, an approval, and a line in the changelog at the bottom of this file.

For the avoidance of doubt: **`announcement.post` and `event.upsert` going live
in `v0.3` did not widen the allowlist.** Both were named in the original scope
and have been in this table since `v0.1`; what changed is that they now work.

---

## 1. The endpoint

```
POST /internal/actions
```

Bound to the private interface only. Not routed from the internet, not behind
a reverse proxy that terminates on a public IP. If the bot process finds
itself listening on a public address at startup it refuses to start — a config
mistake should be a crash, not a quietly-exposed remote control.

### Headers

| Header | Example | Notes |
|---|---|---|
| `Content-Type` | `application/json` | Required. |
| `X-TWO-Key-Id` | `web-prod` | Which shared secret signed this. Lets us rotate one caller's key without downtime. |
| `X-TWO-Timestamp` | `1787173135` | Unix **seconds**. |
| `X-TWO-Nonce` | `9f1c…` (32 hex chars) | 128 bits of randomness. **Fresh on every attempt, including retries.** |
| `X-TWO-Signature` | `sha256=ab12…` | Lowercase hex. |
| `Idempotency-Key` | `1e9d…` (UUID) | Required for actions marked *needs key* in §3. **Stays the same across retries of the same logical operation.** |

### The signature

```
canonical = "POST\n/internal/actions\n{timestamp}\n{nonce}\n{sha256_hex(raw_body)}"
signature = "sha256=" + hex(hmac_sha256(shared_secret, canonical))
```

Signing a hash of the body rather than the body itself keeps the canonical
string short and removes every argument about encoding, whitespace and key
order. Sign the **raw bytes you actually send**; do not re-serialise the JSON
between signing and sending.

Verification is a constant-time compare. A wrong signature and an unknown key
id produce the identical response, deliberately.

### Nonce vs idempotency key — the one that will bite you

They are different things and using one for both breaks retries.

- The **nonce** proves this HTTP attempt is not a recording of an earlier one.
  It must be new every time. Reusing it is a replay and gets rejected.
- The **idempotency key** identifies the *operation*. A retry after a timeout
  sends the **same** idempotency key with a **new** nonce and timestamp — that
  is how the bot knows "this is the announcement you already asked for", not
  "someone is replaying my traffic".

### Freshness and replay

- Timestamp outside **±120 seconds** of the bot's clock → rejected.
- Nonce remembered for **240 seconds** (twice the skew window). A repeat inside
  that window → rejected as a replay, and no Discord call is made.

Nonces live in `internal_nonces`, so **a bot restart forgets nothing** and the
replay guard holds across a deploy. They are scoped per key id: a replay is a
recording of a signed request and therefore always carries the original's key
id, so scoping catches every replay that can exist while making it impossible
for one caller to burn a nonce value out from under another.

Both sides must run NTP. A drifting clock on the website presents as
intermittent, inexplicable 401s.

### Rate limits

Per key id, token bucket: **60 requests/minute sustained, burst 20**, and a
tighter **30/minute** on `guild.add_member`. Over the limit returns `429` with
`Retry-After` in seconds. The limit exists so that a loop bug on the website
is an annoying afternoon rather than our bot getting rate-limited or flagged
by Discord.

---

## 2. Responses

Every response is JSON and carries `request_id`. Quote it when reporting
anything — it is the join key between the website's logs and mine.

**Success**

```json
{ "ok": true, "result": { "outcome": "added" }, "request_id": "01J…" }
```

**Failure**

```json
{ "ok": false,
  "error": { "code": "discord_unavailable",
             "message": "Discord did not answer in 1500ms",
             "retryable": true },
  "request_id": "01J…" }
```

`retryable` is there so the site can branch on a boolean instead of parsing
prose. It is authoritative: if it is `false`, retrying will fail the same way.

| HTTP | `code` | `retryable` | Means |
|---|---|---|---|
| 400 | `malformed` | false | Body did not parse, or a required field is missing or the wrong type. |
| 401 | `unauthorized` | false | Bad signature, unknown key id, or missing auth headers. |
| 401 | `stale_request` | false | Timestamp outside the skew window. Fix your clock. |
| 403 | `action_not_allowed` | false | Well-formed, but that action is not on the allowlist. |
| 409 | `replayed` | false | Nonce already seen. Retrying this exact request never becomes anything else — send a **fresh nonce**. |
| 409 | `in_progress` | **true** | An earlier attempt at this same `Idempotency-Key` has not finished. Retry with the same key and a fresh nonce; you will get the stored result once it lands. |
| 422 | `discord_rejected` | false | Discord answered, and said no. `message` carries its reason. |
| 429 | `rate_limited` | true | Ours or Discord's. Honour `Retry-After`. |
| 500 | `internal` | true | Our bug. It is in my logs with this `request_id`. |
| 502 | `discord_unavailable` | true | Discord errored or was unreachable. |
| 504 | `upstream_timeout` | true | Discord did not answer inside the action's budget. |

There is no response that requires reading English to handle. That is the
point of the table: the site degrades gracefully, it does not white-screen.

**One response header:** `Idempotent-Replay: true` on a `200` means the result
came from the store rather than from a fresh Discord call — the operation
happened on an earlier attempt. The `result` body is byte-identical to what
that attempt returned, so a caller that ignores the header is still correct;
it is there for logging and for showing "already posted" rather than "posted".

---

## 3. The allowlist

| Action | Status | Idempotency | Discord permission needed |
|---|---|---|---|
| `role.assign` | **live** | natural — assigning a held role is a no-op | Manage Roles |
| `announcement.post` | **live** | **needs key** | View Channel + Send Messages in the target channel |
| `event.upsert` | **live** | **needs key** on create; update is natural | Manage Events |
| `guild.add_member` | **built and tested, switched off — awaiting CEO sign-off** (TOG-57) | natural — Discord returns 204 if already a member | Create Instant Invite |

`guild.add_member` only answers when `TWO_INTERNAL_ALLOW_ADD_MEMBER=1`, and
that flag is the record of the CEO's decision rather than a convenience. With
it unset the endpoint returns `action_not_allowed` and makes no Discord call —
the same answer it gives for an action that does not exist. Nothing about the
member-recruiting path is waiting on engineering; it is waiting on approval.

There is a second allowlist inside `role.assign`: the `role_key` map. It starts
from the roles a member can already self-assign in the onboarding menu
(`src/onboarding/catalog.ts`), so handing it to the website grants no privilege
a member does not already have by clicking. `TWO_INTERNAL_ROLE_KEYS` adds
named exceptions to that, one snowflake at a time.

`announcement.post` and `event.upsert` have the same arrangement in the
`channel_key` map, with one difference: it **starts empty**. There is no safe
set of channels to inherit and no way to guess which channel is "announcements",
so a bot with no `TWO_INTERNAL_CHANNEL_KEYS` refuses every post with
`action_not_allowed`. That is the correct answer rather than a gap — naming a
channel is a deliberate act by whoever runs the bot.

**Natural** means Discord itself makes the repeat harmless, so the bot needs no
stored state to be safe. **Needs key** means a repeat would produce a second
announcement or a duplicate event, so the bot stores `idempotency_key →
result` and replays the stored result instead of acting again.

That distinction is not academic — it decides which actions the caller must
send an `Idempotency-Key` for. A *needs key* action without one is a
`malformed`, not a best-effort attempt.

### `role.assign`

```json
{ "action": "role.assign", "discord_id": "…", "role_key": "member" }
```

`role_key`, not a role snowflake. The website never hardcodes a Discord ID, and
the set of assignable keys is a second allowlist inside the first one.
`result: { "outcome": "assigned" | "already_held" }`.

**Server-config prerequisite:** the bot's highest role must sit **above** the
role being assigned in the server's role list. Discord refuses otherwise, and
the failure is a flat 403 with no hint about why. This is a hierarchy question,
not a permission bit, and it is the most common way this action breaks.

### `announcement.post`

```json
{ "action": "announcement.post", "channel_key": "announcements", "body": "…" }
```

`Idempotency-Key` required. Channel by key, same reasoning as roles. The bot
will not post to a channel that is not in the key map, so a bug on the website
cannot address an arbitrary channel.

`body` is at most **2000 characters** — Discord's own ceiling, enforced here so
you get a typed `malformed` naming the field instead of a bare 400 from
Discord.

`result: { "outcome": "posted", "message_id": "…" }`. The message id comes back
on a replay too, so a retry still tells you *which* message you have.

**The announcement cannot ping anybody.** Every post is sent with
`allowed_mentions: { parse: [] }`. The text is posted verbatim — `@everyone`
appears in the message as typed — but it notifies nobody. An announcement is
written by whoever has that form on the website, and that form does not get to
alert a live server of a hundred people.

### `event.upsert`

```json
{ "action": "event.upsert", "event_key": "…", "name": "…",
  "starts_at": "…", "ends_at": "…", "location": "…", "description": "…" }
```

`event_key` is the website's own stable identifier. The bot keeps
`event_key → discord_event_id`, so the same call creates once and updates
thereafter. `Idempotency-Key` required on every call.

Note the two guarantees are different and you need both. The **idempotency
key** makes a *retry of one request* safe. The **event_key mapping** makes a
*deliberate edit next week* land on the same Discord event instead of creating
a second one — send a fresh idempotency key for that, because it is a new
operation.

**Where the event happens: send exactly one of `channel_key` or `location`.**
Discord takes either an event inside a voice channel or an "external" one with
a place written on it, never both and never neither; sending both or neither is
a `malformed` naming the fields rather than Discord's unexplained 400.

- `channel_key` → a voice-channel event, resolved through the same channel
  allowlist as `announcement.post`.
- `location` → an external event, free text.

`starts_at` and `ends_at` are ISO-8601 instants, both required, and `ends_at`
must be after `starts_at`. `name` is at most 100 characters, `description` at
most 1000.

`result: { "outcome": "created" | "updated", "event_id": "…" }`.

### `guild.add_member` — **proposed, not yet approved**

```json
{ "action": "guild.add_member", "discord_id": "…", "access_token": "…" }
```

The one action that recruits members. Requested by the Web Lead on TOG-44 for
TOG-57: the live WordPress site puts a visitor **into the server** on one
click, and the Laravel replacement has to keep that. It is TWO's only working
web-to-Discord conversion path.

The bot calls `PUT /guilds/{guild_id}/members/{user_id}` with the bot token in
the `Authorization` header and the member's OAuth token in the body. Neither
service can do this alone — the website holds the member's token and never the
bot's; the bot holds its own and never the member's. That is a good split and
it is why this belongs on this endpoint rather than anywhere else.

**Result — three outcomes, because they are three different things to show a
person:**

| Discord | `result.outcome` | What the site shows |
|---|---|---|
| 201 | `added` | "You're in." Link them into the server. |
| 204 | `already_member` | Also a success. Show them the way in, not an error. |
| — | error per §2 | Fall back to a plain invite link. |

**Handling of `access_token` — enforced, not merely intended:**

- It is never written to a log line, never to the EventStore, never to disk.
- It exists as a function argument for the life of one request and is not
  copied into any object that gets serialised.
- The audit record for this action stores the action name, caller, member id
  and outcome. There is no field for the token to go in.
- A test asserts that the token value appears in **no** captured log output for
  a successful call, a rejected call and a thrown exception. Conventions rot;
  a failing test does not.

**Timeouts — fast failure, not a durable one.** Agreed, and specified in §5.

---

## 4. Logging and audit

Every request, accepted or rejected, produces one structured line: timestamp,
`request_id`, key id, action, outcome, duration, and the Discord status where
there was one. Rejections log the *reason code*, so a run of `stale_request`
is visibly a clock problem rather than an unexplained pile of 401s.

Never logged: shared secrets, the bot token, `access_token`, announcement body
content beyond its length.

**The durable audit trail** is `internal_action_log`, one row per request,
accepted or rejected:

```sql
SELECT created_at, key_id, action, idempotency_key, outcome, code, status, reason, duration_ms
  FROM internal_action_log
 WHERE created_at > '2026-08-25'
 ORDER BY created_at DESC;
```

`request_id` is the primary key, so a row joins straight to the website's own
logs and to our stdout line. `key_id` and `action` are NULL on requests
rejected before we knew who was calling — an unauthenticated caller must not be
able to write rows attributed to a real one.

Two properties of this table worth knowing:

- **It never holds a request body.** Not the announcement text, not an
  `access_token`, not a signature. `internal_idempotency` stores a *sha256* of
  the body so a key reused for different content can be caught, and nothing
  else. A test asserts this across all three tables.
- **Writing it is best-effort, deliberately.** The response is already sent by
  the time the audit row is written, so a database outage degrades the trail
  rather than failing a request the bot has already carried out. The failure is
  itself logged as `internal_audit_write_failed`, so a silent gap is not
  possible.

---

## 5. Synchronous vs queued

The convention for this endpoint is: **the website queues a job, the job calls
us.** A queue gives durable retries, which is right for an announcement that
must eventually post.

**`guild.add_member` is the deliberate exception, and the Web Lead is right to
ask for it.** Two reasons, and the second is the stronger one:

1. A member is standing there waiting for an answer. A queue turns a two-second
   interaction into an indeterminate one.
2. **Queuing means writing a live member credential into the `jobs` table in
   plaintext**, where it sits in the queue, in `failed_jobs` on error, and in
   every database backup taken afterwards. The synchronous call keeps that
   token in memory on two hops and nowhere else. That is a straight security
   win and it outweighs the convention.

So for this one action:

| | |
|---|---|
| Website's HTTP timeout | **2s** |
| Bot's own budget for the Discord call | **1500ms** |
| Retries by the bot | **none** — no 429 backoff wait, no 5xx retry |
| On any failure | typed error per §2, site falls back to an invite link |

The bot's budget sits inside the caller's on purpose: I return a clean typed
error at 1500ms rather than both sides timing out and the site having to guess.

**The timeout race is benign, and you should not try to compensate for it.**
If the bot's call to Discord succeeds at 2.1s and the website has already given
up, the member was added *and* is shown the invite-link fallback. Following
that link lands an existing member in the server they are already in, which is
exactly what we wanted. Do not build a compensating "undo" for this case — the
worst outcome is one redundant click.

---

## 6. What is built, and the one thing that is not

The Postgres dependency (TOG-37) landed on 2026-08-25, and with it everything
this section used to list as blocked.

| Piece | State |
|---|---|
| HTTP listener, HMAC verify, skew, rate limit | **built** |
| Typed error envelope | **built** |
| Structured request logging | **built** |
| `role.assign`, `guild.add_member` | **built** (the latter switched off, §3) |
| `announcement.post`, `event.upsert` | **built** |
| Durable `idempotency_key → result` | **built** — `internal_idempotency` |
| Durable audit trail | **built** — `internal_action_log` |
| Nonce replay guard surviving a restart | **built** — `internal_nonces` |
| Join attribution for one-click joins (§7) | **built** — TOG-464, `src/core/expectedJoins.ts` |

**The honest limit that remains, and it is not the old one.** Idempotency is
at-most-once inside a living process. If the bot dies *between* claiming a key
and recording the result — a window that is exactly the length of one Discord
call — the row is left `in_flight`, and after 60 seconds another attempt may
take it over and re-post. The alternative is leaving that operation
permanently stuck, which is worse. The window is bounded, it requires a crash
inside a sub-second window to reach, and every claim and takeover is in
`internal_action_log`.

The old limit — "a restart re-opens a ≤240-second replay window" — is gone.
Nonces are a table.

---

## 7. One-click joins have to be countable

**Built (TOG-464).** A one-click join arrives through
`PUT /guilds/.../members/...`, so **no invite code is consumed**. Without this
piece the invite tracker would see a join it cannot attribute and file it as
`unknown` (`docs/EVENTS.md`) — we would ship TWO's best conversion path and
have no way to tell whether it converts anybody.

The fix, and it costs the website nothing: at the moment the bot makes the add
call, it notes "expect a join for this member id within 30s, source
`web:one_click`" (`src/core/expectedJoins.ts`). The gateway `guildMemberAdd`
handler consumes that note and stamps the source. No token involved, no extra
request, no new field from the caller.

Three details of the implementation worth knowing:

- **The note is taken before the Discord call**, because the gateway can
  deliver the join before the REST response returns. A note for a call that
  then fails is harmless — nobody joins, and it expires after 30 seconds.
- **The note beats the invite diff.** A member the bot itself just added
  provably came through the web path; any invite code that grew in the same
  window belongs to some other join. The invite snapshot is still taken on
  every join, so the counters stay correct for the next organic one.
- **It is in-memory, deliberately.** The add call and the gateway event are
  seconds apart inside one process. If the bot dies between them the join is
  filed `unknown`, the same honest fallback as a join during downtime.

`web:one_click` is one new value in the `source` column — an additive change to
`web_v1.funnel_by_source`, no view shape moved, runtime contract still `1.0`
(`docs/WEBSITE_CONTRACT.md` §1).

This matters more than it looks. "New members joining" is the number the whole
company is judged on, and an unattributed join is an argument nobody can win.

---

## 8. The permission bill

**Reconciled by TOG-64 (2026-09-02).** `docs/SECRETS.md` now documents the
target grant as the six-bit set (`View Channels`, `Manage Server`,
`Manage Roles`, `Manage Events`, `Create Instant Invite`, `Send Messages`),
permission integer `8858373153`, not the old two-bit `View Channels + Manage
Server` target this section used to warn against. The bot in the live server
currently holds Administrator; applying the narrower grant is a Discord-portal
change still pending, gated on whoever administers the server.
`scripts/preflight.ts` now asserts all four bits below explicitly, so a future
trim cannot silently drop one again.

Manage Server does **not** imply Manage Roles, Manage Events, or Create Instant
Invite; they are separate bits.

| Action | Permission |
|---|---|
| `role.assign` | Manage Roles (+ bot's role above the target role) |
| `announcement.post` | View Channel + Send Messages in that channel |
| `event.upsert` | Manage Events |
| `guild.add_member` | **Create Instant Invite** |

**`v0.3` added two entries to this bill.** `announcement.post` needs View
Channel + Send Messages in whichever channel `TWO_INTERNAL_CHANNEL_KEYS` names,
and `event.upsert` needs **Manage Events** — a separate bit that Manage Server
does not imply. Both are live now, so the reconciliation covers four actions
rather than two.

---

## 9. The OAuth application constraint

Discord: *the Authorization header must be a Bot token belonging to the same
application used for authorization.*

So the website's OAuth **client id and client secret must come from the same
Discord application as the bot**, not a separate login-only application. A
separate app signs people in perfectly well and then fails `guild.add_member`
forever, with no workaround. The Web Lead has posted the correction on TWO-21;
confirmed from my side.

The boundary holds: a client id and secret are not the bot token and cannot be
exchanged for one. The website still never holds it.

The client secret is a real secret all the same — it can mint OAuth flows in
our application's name — so it travels through `docs/SECRETS.md` like anything
else, and it rotates independently of the bot token.

---

## 10. Tests, before the code

Named here so the list is agreed before there is anything to argue about.
**Everything below is green.** Nothing on this list is deferred any more.

- Valid request for each allowlisted action → the expected Discord call.
- Tampered body, valid signature → `unauthorized`.
- Valid body, tampered signature → `unauthorized`.
- Unknown key id → `unauthorized`, byte-identical to a bad signature.
- Timestamp 121s old, and 121s in the future → `stale_request`.
- Replayed nonce inside the window → `replayed`, **and no Discord call made**.
- Same idempotency key, fresh nonce → the stored result, **and no second post**.
- Same idempotency key, *different body* → `malformed`, not somebody else's result.
- A key-requiring action with no `Idempotency-Key`, or a malformed one → `malformed`.
- Two overlapping attempts at one key → the second gets `in_progress`, and only
  the claim holder calls Discord.
- A failed attempt releases its key, so the retry is a real second attempt and
  not a cached failure.
- The replay guard holds across a restart (two servers, one store).
- Action not on the allowlist → `action_not_allowed`.
- A `channel_key` outside the map → `action_not_allowed`, nothing sent.
- `event.upsert` creates once, then updates the same Discord event.
- `event.upsert` with both or neither of `channel_key`/`location`, or with
  `ends_at` before `starts_at` → `malformed`.
- Malformed JSON, missing field, wrong type → `malformed`.
- Over the rate limit → `429` with `Retry-After`.
- Discord 5xx / timeout / 429 → the right typed error, no retry storm.
- `guild.add_member`: 201 → `added`; 204 → `already_member`.
- `guild.add_member`: `access_token` appears in no log line, on success, on
  rejection, and on a thrown exception.
- Every request lands in `internal_action_log`, accepted or rejected, with the
  key id withheld on an unauthenticated one.
- **No request body reaches any of the three tables** — asserted by putting a
  marker string through `announcement.post` and `guild.add_member` and grepping
  the lot.

---

---

## 11. Running it

Off by default. A bot with none of these set behaves exactly as it did before
and opens no port.

| Variable | Meaning |
|---|---|
| `TWO_INTERNAL_ACTIONS` | `1` to run the listener at all. |
| `TWO_INTERNAL_BIND_HOST` | Private address to bind. Default `127.0.0.1`. A public or wildcard address refuses to start. |
| `TWO_INTERNAL_PORT` | Default `8787`. |
| `TWO_INTERNAL_KEYS` | `key-id:secret,key-id:secret`. Minimum 32 characters each. A real secret — see `docs/SECRETS.md`. |
| `TWO_INTERNAL_ROLE_KEYS` | Extra `role-key:<snowflake>` pairs beyond the self-assignable set. |
| `TWO_INTERNAL_CHANNEL_KEYS` | `channel-key:<snowflake>` pairs for `announcement.post` and `event.upsert`. **Empty by default** — with none set, there is no channel the website may address. |
| `TWO_INTERNAL_ALLOW_ADD_MEMBER` | `1` to enable `guild.add_member`. **Requires the CEO's sign-off.** |

`DISCORD_GUILD_ID` is required when the endpoint is on — the actions act on one
guild, and guessing which is not a thing this should do.

The endpoint uses the bot's existing database; there is nothing extra to
configure for it. `migrations/0002_internal_actions.sql` is applied by the
normal `npm run migrate`, and the four tables are covered by the same backups
as everything else.

At boot the listener logs `internal_actions_listening` with `durable: true`
when the store is wired. **If you ever see `durable: false` in production,
the replay guard is running in process memory and a restart re-opens a
240-second window** — that is a misconfiguration, not a mode.

Tests: `test/unit.internalauth.test.ts` (signature, skew, replay, buckets, bind
guard, error table), `test/unit.internalstore.test.ts` (nonce expiry, claim
takeover, the sweep — everything with a clock in it), and
`test/e2e.internalactions.test.ts` (the §10 list over real HTTP, against
`tools/mock-discord`).

---

## Changelog

| Version | Date | Change |
|---|---|---|
| `v0.1` | 2026-08-19 | First specification. Three approved actions from TWO-24, plus `guild.add_member` proposed on TWO-57 and awaiting CEO sign-off. |
| `v0.2` | 2026-08-19 | TWO-59: the pre-Postgres slice implemented — listener, HMAC, skew, replay, rate limits, error envelope, request logging, `role.assign` live and `guild.add_member` built but switched off. No wire-format change. |
| `v0.4` | 2026-09-03 | TOG-464: join attribution for one-click joins (§7) built — the last unbuilt piece of this page. No wire-format change: the caller sends nothing new, and the only observable difference is that a `guild.add_member` join lands in the funnel as `web:one_click` instead of `unknown`. |
| `v0.3` | 2026-08-25 | TOG-44: the endpoint completed on top of Postgres (TOG-37). `announcement.post` and `event.upsert` built and live; durable idempotency store, durable audit trail, table-backed replay guard. **The allowlist did not widen** — both new actions were approved in the original scope. Additive wire changes only: one new error code `in_progress` (409, retryable), one new response header `Idempotent-Replay`, and `event.upsert` now takes `location` as the alternative to `channel_key`. |

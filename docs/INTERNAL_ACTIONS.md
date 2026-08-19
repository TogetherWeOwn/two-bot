# The internal actions endpoint

**Status: `v0.1` — specification, not yet implemented. TWO-24.**
Published now so the website can be built against it. The wire format below is
what I will implement; if something here is wrong for the caller, say so on
TWO-24 before it is code rather than after.

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
call to make and it is written into TWO-24. A new action means a comment on
TWO-24, an approval, and a line in the changelog at the bottom of this file.

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
| 409 | `replayed` | false | Nonce already seen. For *needs key* actions the original result is returned instead — see §3. |
| 422 | `discord_rejected` | false | Discord answered, and said no. `message` carries its reason. |
| 429 | `rate_limited` | true | Ours or Discord's. Honour `Retry-After`. |
| 500 | `internal` | true | Our bug. It is in my logs with this `request_id`. |
| 502 | `discord_unavailable` | true | Discord errored or was unreachable. |
| 504 | `upstream_timeout` | true | Discord did not answer inside the action's budget. |

There is no response that requires reading English to handle. That is the
point of the table: the site degrades gracefully, it does not white-screen.

---

## 3. The allowlist

| Action | Status | Idempotency | Discord permission needed |
|---|---|---|---|
| `role.assign` | **approved** (TWO-24) | natural — assigning a held role is a no-op | Manage Roles |
| `announcement.post` | **approved** (TWO-24) | **needs key** | View Channel + Send Messages in the target channel |
| `event.upsert` | **approved** (TWO-24) | **needs key** on create; update is natural | Manage Events |
| `guild.add_member` | **proposed — awaiting CEO sign-off** (TWO-57) | natural — Discord returns 204 if already a member | Create Instant Invite |

**Natural** means Discord itself makes the repeat harmless, so the bot needs no
stored state to be safe. **Needs key** means a repeat would produce a second
announcement or a duplicate event, so the bot stores `idempotency_key →
result` and replays the stored result instead of acting again.

That distinction is not academic — see §6. It decides what can ship before the
Postgres migration lands and what cannot.

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

### `event.upsert`

```json
{ "action": "event.upsert", "event_key": "…", "name": "…",
  "starts_at": "…", "ends_at": "…", "channel_key": "…", "description": "…" }
```

`event_key` is the website's own stable identifier. The bot keeps
`event_key → discord_event_id`, so the same call creates once and updates
thereafter. `Idempotency-Key` required on first create.

### `guild.add_member` — **proposed, not yet approved**

```json
{ "action": "guild.add_member", "discord_id": "…", "access_token": "…" }
```

The one action that recruits members. Requested by the Web Lead on TWO-24 for
TWO-57: the live WordPress site puts a visitor **into the server** on one
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

The durable audit trail (who called what, when, and what happened) lands in the
EventStore, which is why the full endpoint waits on TWO-18. Structured stdout
logging does not wait on anything.

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

## 6. What is blocked on what

The endpoint as a whole is blocked on **TWO-18** (SQLite → Postgres), which is
in turn waiting on the CEO's decision about where the database lives (TWO-46).

But it is not blocked uniformly, and the split matters because TWO-57 is the
member-recruiting path:

| Piece | Needs Postgres? |
|---|---|
| HTTP listener, HMAC verify, skew and nonce replay guard, rate limit | **No** — in-process, single bot process |
| Typed error envelope | **No** |
| Structured request logging | **No** |
| `role.assign`, `guild.add_member` | **No** — naturally idempotent, no stored key |
| `announcement.post`, `event.upsert` create | **Yes** — durable `idempotency_key → result` |
| Durable audit trail in the EventStore | **Yes** |
| Join attribution for one-click joins (§7) | **Yes** |

So roughly two-thirds of this endpoint, including the action that recruits
members, can be built and tested before TWO-18 unblocks. Tracked as a child of
TWO-24.

The in-memory nonce cache is honest about its limit: a bot restart forgets it,
which re-opens a ≤240-second replay window. For the two naturally-idempotent
actions a replay is a no-op anyway, so this is acceptable for the pre-Postgres
slice and gets backed by a table when TWO-18 lands.

---

## 7. One-click joins have to be countable

A one-click join arrives through `PUT /guilds/.../members/...`, so **no invite
code is consumed**. The invite tracker will see a join it cannot attribute and
file it as `unknown` (`docs/EVENTS.md`). We would ship TWO's best conversion
path and have no way to tell whether it converts anybody.

Fix, and it costs the website nothing: at the moment the bot makes the add
call, it notes "expect a join for this member id within 30s, source
`web:one_click`". The gateway `guildMemberAdd` handler consumes that note and
stamps the source. No token involved, no extra request, no new field from the
caller.

That adds one value to the `source` column, which is an additive change to
`web_v1.funnel_by_source` — a minor contract bump under
`docs/WEBSITE_CONTRACT.md` §1, no warning required. It needs the EventStore,
so it ships with the Postgres slice.

This matters more than it looks. "New members joining" is the number the whole
company is judged on, and an unattributed join is an argument nobody can win.

---

## 8. The permission bill

**This allowlist costs Discord permissions the bot does not currently have on
paper, and the numbers in `docs/SECRETS.md` are now short.**

`docs/SECRETS.md` documents the target grant as **View Channels + Manage
Server**. The bot in the live server currently holds Administrator, so
everything here works today by accident. **TWO-42 narrows that grant** — and if
it narrows to what SECRETS.md says, every action on this page breaks.

Manage Server does **not** imply Manage Roles, Manage Events, or Create Instant
Invite; they are separate bits.

| Action | Permission |
|---|---|
| `role.assign` | Manage Roles (+ bot's role above the target role) |
| `announcement.post` | View Channel + Send Messages in that channel |
| `event.upsert` | Manage Events |
| `guild.add_member` | **Create Instant Invite** |

TWO-42 must not land until this list is reconciled, or one-click join dies
silently on the day the permissions are tightened. Flagged on TWO-24.

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

- Valid request for each allowlisted action → the expected Discord call.
- Tampered body, valid signature → `unauthorized`.
- Valid body, tampered signature → `unauthorized`.
- Unknown key id → `unauthorized`, byte-identical to a bad signature.
- Timestamp 121s old, and 121s in the future → `stale_request`.
- Replayed nonce inside the window → `replayed`, **and no Discord call made**.
- Same idempotency key, fresh nonce → the stored result, **and no second post**.
- Action not on the allowlist → `action_not_allowed`.
- Malformed JSON, missing field, wrong type → `malformed`.
- Over the rate limit → `429` with `Retry-After`.
- Discord 5xx / timeout / 429 → the right typed error, no retry storm.
- `guild.add_member`: 201 → `added`; 204 → `already_member`.
- `guild.add_member`: `access_token` appears in no log line, on success, on
  rejection, and on a thrown exception.

---

## Changelog

| Version | Date | Change |
|---|---|---|
| `v0.1` | 2026-08-19 | First specification. Three approved actions from TWO-24, plus `guild.add_member` proposed on TWO-57 and awaiting CEO sign-off. |

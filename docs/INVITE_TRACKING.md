# Invite click tracking

**`go.two.gg/<campaign>` → log an `invite_click` → 302 to the Discord invite.**
That is the whole system. It exists because Discord reports invite clicks to
nobody.

## Why it has to work this way

Discord gives us one signal about invites: a use count that goes up when someone
joins. There is no click count, no impression count, and no API that will ever
return one. So the people who saw an invite and decided *against* joining are
completely invisible — and they are the ones worth knowing about.

Without this, "we got 4 joins" has two possible causes with opposite fixes:

| What happened | What it means | What to do |
|---|---|---|
| 8 clicks → 4 joins | Reach is the problem. Few people saw it. | Post in more places. |
| 400 clicks → 4 joins | First impression is the problem. | Fix the landing experience. |

A short link we control is the only way to tell those apart, because it is the
only point in the journey that happens on infrastructure we own.

## What is recorded, and what is not

A click row is **a campaign and a timestamp**. That is the entire record.

- No cookies. No fingerprinting. No IP address, user agent or referrer.
- The query string is dropped without being parsed — `?fbclid=…` and friends are
  exactly the identifying data we are refusing to collect.
- `member_id` is `NULL`, always. We do not know who clicked and do not try.

`test/unit.redirect.test.ts` asserts this by sending a request stuffed with
identifying headers and failing if any of it reaches the database. See
`docs/PRIVACY.md`.

## Running it

The redirect is **a separate process from the bot**. It holds no Discord token
and never calls the Discord API — it reads a table and writes an event. Keeping
it separate means restarting it never touches the gateway connection, and a
crawler hammering a link cannot destabilise the bot.

```bash
npm run redirect          # binds 127.0.0.1:8088 by default
```

| Variable | Meaning |
|---|---|
| `TWO_REDIRECT_BIND_HOST` | Default `127.0.0.1`, for the reverse proxy in front. |
| `TWO_REDIRECT_PORT` | Default `8088`. |
| `DISCORD_GUILD_ID` | Which guild clicks belong to. Required. |
| `TWO_REDIRECT_FALLBACK_CODE` | Invite code for `/` and for database outages. |
| `TWO_REDIRECT_BASE_URL` | What `npm run campaigns` prints. Default `https://go.two.gg`. |

Put it behind the host's existing reverse proxy, terminating TLS for
`go.two.gg`. Unlike `/internal/actions`, this one is *meant* to be public: it is
a link we hand to strangers, and the worst it can do is send someone to an
invite that is already public.

### DNS

`go.two.gg` needs an A/AAAA record pointing at the box, and TLS. As of
2026-09-03 `two.gg` resolves (Cloudflare) and `go.two.gg` does not yet exist —
that record is the one manual step between this code and live numbers.

## Adding a link

```bash
npm run campaigns                                            # list
npm run campaigns -- --add reddit aB3xY9 "r/MMORPG sidebar"  # add
npm run campaigns -- --retire reddit                         # stop listing it
```

Adding a link is a community decision made the moment somebody is about to post
somewhere, so it is a row in a table, not a deploy.

**Give each place its own Discord invite code.** Two campaigns *may* share a
code, and clicks are still reported separately — but a join only ever carries
the code, never the campaign, so sharing one means you learn which link was
clicked and never which one produced members. Members are the point.
`npm run funnel` prints a warning when it finds a shared code.

Retiring never breaks a link. A retired campaign still redirects forever,
because a Reddit comment from eight months ago cannot be edited; it just stops
being listed as current.

## Reading the numbers

```bash
npm run funnel
```

```
  invite clicks           412
  joins                    38     9% of clicks

  Tracked links (clicks -> joins on the same invite code):
    reddit      380 clicks    31 joins    8%  r/MMORPG sidebar
    twitch       32 clicks     7 joins   22%  Twitch panel
```

Two things that are not bugs:

- **More joins than clicks.** Expected while some invites are posted as raw
  `discord.gg` links — those are clicked off-platform where we cannot see them.
  The report says so on its own line when it happens.
- **Clicks with no joins on a brand new link.** Attribution runs off invite
  use-count deltas, which the bot only observes while it is running.

## Design notes

Decisions worth not re-litigating:

- **302, never 301.** A permanent redirect is cached by the browser and every
  proxy between, so the second click from that person never reaches us and the
  campaign silently stops counting. This is the single easiest way to break the
  whole feature.
- **Redirect first, record after.** The person is why we are here. A failed
  database write costs us one click in a report; making them wait on it, or
  crashing, costs us a member.
- **HEAD requests do not count.** Discord itself HEADs a URL when someone pastes
  it into a channel. Counting those would inflate every campaign the instant it
  is shared, in proportion to how much it was shared — the worst possible bias.
- **A per-request dedupe token.** `invite_click` has no `member_id`, so its
  idempotency key is guild + type + timestamp. Two people clicking in the same
  millisecond would collide and the second would be dropped as a duplicate,
  under-counting the denominator and making conversion look *better* than it is.
  `FunnelEvent.dedupeToken` is random per request and is not derived from
  anything about the visitor.
- **Abuse limits are per caller, not per campaign.** One IP gets 60 requests
  with a 1/sec refill (`CLICK_BUCKET` in `src/redirect/server.ts`, proved by
  `test/unit.redirect.test.ts`), then 429s. That caps how badly one broken
  crawler can inflate the count. It does not stop a burst spread across many
  IPs against one campaign — throttling that would need cross-IP campaign
  counters, which is an open question tracked as TOG-5895. Unknown slugs 404
  with no redirect target, so there is no open redirect to launder links through.
- **A database outage redirects anyway** when a fallback code is set. Losing the
  measurement is much cheaper than turning a live link into a 404 that a crawler
  caches.

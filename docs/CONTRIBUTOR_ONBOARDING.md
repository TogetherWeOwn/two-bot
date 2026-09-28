# Contributing to the TWO pilot

**You are welcome here, and there is a job for you on day one.** This guide
takes you from "just joined" to "hosted something / fixed something" in one
sitting. No engineering background needed for most of it.

What the pilot is: we are learning **how people find TWO, whether they join,
and whether they stick around** — with trustworthy numbers first, automation
second. Pilot contributors welcome newcomers, host the weekly event, and fix
the docs and small things they trip over. Humans come first; bots are labeled
and stay under 20% of the chatter.

Channel names move occasionally. If a channel below does not exist, follow the
links in the server's welcome message — those are always current. (`#general`
and `#events` below are the usual names; the same fallback applies if they
have moved.)

## 1. Join the pilot

1. **Grab the current invite** from the announcements post or a staff member
   and join the Discord server.
2. **Accept the rules** on the membership screen. This clears the gate and the
   bot records it (event `gate_cleared`) — it is how we know you are really in.
3. **Follow the welcome message**: pick your games in the game picker and follow the channel
   links it hands you. Picking a game grants you its role (each pick maps to
   a role — see `src/onboarding/catalog.ts`) and opens its channels.
4. **Say hi in general.** Your first message in welcome/general starts a friendly clock: we
   measure how fast a newcomer gets their **first human reply** (counted from
   rules acceptance when we have it — see [docs/COMMUNITY_SCORECARD.md](COMMUNITY_SCORECARD.md)).
   Someone usually answers — and whether one does is itself a pilot number,
   so saying hi is genuinely contributing either way.
5. **Come back once that week.** Showing up again is what turns a join into a
   habit. Voice counts too — the scorecard counts you active for the week with
   one message or ten minutes of voice (600 unioned voice seconds).

**Your privacy:** we store Discord user IDs, timestamps, channel IDs, and
which invite (code + inviter) a join came from — never public message
content or email. Automod inspects public messages in memory and stores no
content. (Private support tickets keep a staff-only transcript for 90 days.)
Full detail: [docs/PRIVACY.md](PRIVACY.md).

## 2. Host checklist

Hosting is the highest-value contribution in the pilot: the goal needs a
**weekly event, four weeks running**. You do not need permission to co-host;
you need a co-host and this checklist.

**Before (at least 3 days out)**

- [ ] Pick the game, day and start time. Check `#events` for clashes first.
- [ ] Post the event: game, time with timezone, voice channel, who it suits
       (beginners welcome? mic required?). Pin it if you can.
- [ ] Line up a co-host. If you disconnect mid-event, they carry on.
- [ ] Know the conduct basics below — you are the person newcomers copy.

**During**

- [ ] Start on time, in the advertised voice channel.
- [ ] Welcome every newcomer by name in the first minute. Nobody sits in
       silence while regulars catch up.
- [ ] Record attendance with `/attendance event-occurrence:<id> member:<member>`
       (needs Discord `Manage Events`; repeat check-ins for the same
       event/member are idempotent). Headcount is a pilot metric — an RSVP
       is not attendance, so check in each person who actually showed.
       A rough number beats none.
- [ ] Keep bot and automation chatter down. If a bot is spamming the channel,
       mute it for the event and tell staff after.
- [ ] End on time. Thank people by name, say when the next one is.

**After**

- [ ] Drop a two-line recap in `#events`: how many showed, one thing that
       worked, one thing to change.
- [ ] Report anything broken (bot misbehaving, wrong role, confusing welcome)
       to staff or as a docs fix — see §4.

**If something goes wrong**

- A sudden burst of unknown joins, spam, or abuse: **do not engage**. Mute the
  channel if you can, ping a moderator, keep hosting everyone else. A
  join-burst detector alerts staff automatically (`src/analytics/raidWatch.ts`),
  and a written raid playbook is here:
  [docs/RAID-RESPONSE.md](RAID-RESPONSE.md).
- Harassment directed at anyone: shut it down once, briefly, then escalate to
  a moderator. You are not expected to adjudicate.

**Running the bot's infrastructure yourself** (a server host, not an event
host) is a separate path: start at [docs/DEPLOY.md](DEPLOY.md), with
[docs/RUNBOOK.md](RUNBOOK.md) for day-to-day operation.

## 3. Conduct

Short version: **be someone a nervous newcomer is glad to meet.**

- No harassment, hate, slurs, or sexual content. No exceptions, no "banter"
  defense.
- No spam, scams, crypto pitches, or mass-DMs to members. One unsolicited
  sales DM is a ban.
- No raid behavior, alt-account games, or helping anyone evade moderation.
- Spoilers for current games go in spoiler tags.
- Staff and moderator calls are final in the moment. Disagree? Appeal
  afterwards by DMing a moderator — calmly, once. Note: the bot never sends
  DMs or mass messages (that needs CEO sign-off first — see
  [CONTRIBUTING.md](../CONTRIBUTING.md)), so appeals to a human are the path.
- Enforcement uses warnings, timeouts (the persistent escalation layer),
  kicks and temporary/permanent bans, every action logged with a reason and
  an idempotency key. Tooling context: [docs/MODERATION.md](MODERATION.md).

Breaking conduct can end the pilot for you. That is the whole policy, and it
is deliberately short.

## 4. Your first contribution

Pick **one** lane. All three count, all three get reviewed by a human.

| Lane | First step | Size |
|---|---|---|
| **Host or co-host** | Volunteer under the next `#events` post, run the checklist in §2 | One evening |
| **Fix the docs** | Find one wrong or confusing sentence in `docs/` or this file, open a PR that fixes it | One paragraph |
| **Report an oddity** | Numbers look wrong, welcome message confusing, role missing — tell staff with *what, where, when* | Five minutes |

**Docs-PR path** (the repo's rules, condensed — full version:
[CONTRIBUTING.md](../CONTRIBUTING.md)):

```bash
gh auth setup-git   # once per machine; without it git cannot reach the private repo
git clone https://github.com/TogetherWeOwn/two-bot.git
cd two-bot
npm ci --include=dev
npm run e2e:selftest   # first green run: no token, no database, loopback only
git checkout -b docs/short-description
# edit, then (needs a running Postgres 17+ with a scratch database,
# e.g. `createdb two_bot_test` — the repo does not provision one for you):
TWO_TEST_DATABASE_URL=postgres://localhost:5432/two_bot_test npm test   # must pass before you open the PR
```

`npm run e2e:selftest` boots `tools/mock-discord/`, runs one canned
`gateway-bot` probe, and exits 0 (`ok gateway-bot -> ws://127.0.0.1:<port>/gw`,
then `self-test passed`). It needs no Discord token and no Postgres — this is
the green mock-transport run a fresh checkout should reach first. If it fails,
stop here; the suite and the mock-bot flow below both build on it.

Batch-2 staging/dev scripts boot the same credential-free way:
`npm run <name> -- --help` exits 0 with no token, no database, no network
(`staging:discord-fetch`, `staging:session-demo`, `staging:temp-voice-demo`,
`staging:voice-occupant`, `staging:clean-slate`,
`staging:announcements-proof/state/verify`, `mutate:tempvoice`, `e2e:harness`,
`test:report`, `backup:upload-s3`, `internal-actions:host`,
`internal-actions:host-real`). Guard: `node scripts/check-script-targets.ts` —
every `node scripts/<x>` target in `package.json` must exist on disk.

To watch the unmodified bot against the mock (needs a scratch Postgres of your
own, separate from the test database — e.g. `createdb two_bot_dev`; the mock
replaces Discord, not Postgres, and the bot auto-applies migrations on boot):

```bash
node tools/mock-discord/run.ts
# prints DISCORD_API_BASE and DISCORD_GUILD_ID; in another shell:
TWO_DATABASE_URL=postgres://localhost:5432/two_bot_dev DISCORD_TOKEN=mock DISCORD_API_BASE=http://127.0.0.1:<port>/api DISCORD_GUILD_ID=<printed-id> node src/index.ts
```

Full mock-bot detail lives in the [README](../README.md) (`Running it with no
Discord token at all`); live staging stays in [docs/STAGING.md](STAGING.md)
and needs the staging token, never the live one.

Without `TWO_TEST_DATABASE_URL` the suite fails fast with
`TWO_TEST_DATABASE_URL is required` (verified: `npm test` with no database
errors out of `test/helpers/testDb.ts`, it never runs silently green).
Open the PR from your branch against `main` **from inside this repo** —
a fork's PR is refused on purpose (self-hosted runners execute workflow
code, so `scripts/ci/refuse-fork-pr.sh` fails fork PRs; a maintainer can
push your branch here instead). CI runs the check job (script-target and
credential guards, typecheck, funnel-attribution eval, `test:postgres`
wrapper, restart-storage provisioning, grant self-test) and the
postgres job (migrate, web views, website-role checks), plus a secret scan —
all must be green (full list: [CONTRIBUTING.md](../CONTRIBUTING.md)). A code
owner reviews it; you cannot approve your own PR (note: review is
auto-requested from the owner via `.github/CODEOWNERS` but not
server-enforced on this plan — see [CONTRIBUTING.md](../CONTRIBUTING.md)).
Name branches `type/short-description` (`docs/…`, `fix/…`, `feat/…`).
Never put a token or private key in a commit — a pushed secret gets rotated,
not just deleted (the secret scan walks full history, so removing it in a
later commit does not help).

**What happens after:** a reviewer reads it, you get comments or an approval,
and it merges. Contributors are thanked in the irregular contributor
spotlight (public merged-PR history only, with your OK to the final text —
see `community/contributor-spotlight-template.md`). Then pick the
next one — regulars are just newcomers who came back.

## Questions?

Ask in general or DM a moderator. There are no stupid questions in week one;
there is only the confusion you spotted that the next newcomer will hit too —
and that is your second contribution.

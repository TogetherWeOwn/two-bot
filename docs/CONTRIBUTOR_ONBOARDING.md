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
links in the server's welcome message — those are always current.

## 1. Join the pilot

1. **Grab the current invite** from the announcements post or a staff member
   and join the Discord server.
2. **Accept the rules** on the membership screen. This clears the gate and the
   bot records it (event `gate_cleared`) — it is how we know you are really in.
3. **Follow the welcome message**: pick your games and follow the channel
   links it hands you. Picking a game grants you its role and opens its
   channels.
4. **Say hi in general.** Your first message starts a friendly clock: we
   measure how fast a newcomer gets their **first human reply**, and someone
   will answer you. That reply-time number is one of the pilot's headline
   metrics, so saying hi is genuinely contributing.
5. **Come back once that week.** Showing up twice is what turns a join into a
   regular. Voice counts too — ten minutes in a voice channel counts the same
   as a message.

**Your privacy:** we store Discord user IDs, timestamps and channel IDs —
never public message content, email, or anything else. (Private support
tickets keep a staff-only transcript for 90 days.) Full detail:
[docs/PRIVACY.md](PRIVACY.md).

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
- [ ] Mark attendance the way the event post says (host check-in). Headcount
       is a pilot metric — a rough number beats none.
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
  channel if you can, ping a moderator, keep hosting everyone else. There is a
  join-burst detector that alerts staff, and a written raid playbook here:
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
  afterwards by DMing a moderator — calmly, once.
- Enforcement uses warnings, timeouts, kicks and bans, every action logged
  with a reason. Tooling context: [docs/MODERATION.md](MODERATION.md).

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
gh auth setup-git   # once per machine; the repos are private
git clone https://github.com/TogetherWeOwn/two-bot.git
cd two-bot
npm ci --include=dev
git checkout -b docs/short-description
# edit, then (needs a running Postgres 17+ with a scratch database):
TWO_TEST_DATABASE_URL=postgres://localhost:5432/two_bot_test npm test   # must pass before you open the PR
```

Open the pull request against `main`. CI runs the check job (typecheck,
`test:postgres` wrapper, restart-storage provisioning, grant self-test) and the
postgres job (migrate, web views, website-role checks), plus a secret scan —
all must be green (full list: [CONTRIBUTING.md](../CONTRIBUTING.md)). A code
owner reviews it; you cannot approve your own PR. Name branches
`type/short-description` (`docs/…`, `fix/…`, `feat/…`). Never put a token or
private key in a commit — a pushed secret gets rotated, not just deleted.

**What happens after:** a reviewer reads it, you get comments or an approval,
it merges, and your name is on the pilot's contributor list. Then pick the
next one — regulars are just newcomers who came back.

## Questions?

Ask in general or DM a moderator. There are no stupid questions in week one;
there is only the confusion you spotted that the next newcomer will hit too —
and that is your second contribution.

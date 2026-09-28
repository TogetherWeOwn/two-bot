# Server audit

A point-in-time, read-only inventory of the live TWO Discord server, kept in
the repo so the next audit is a `git diff` instead of a redo.

Built to the `audit-spec` document on TWO-13. The deliverable is the
`server-audit` document on that issue; this directory is the working data
behind it.

## Re-running it

```bash
DISCORD_BOT_TOKEN=<bot token> DISCORD_GUILD_ID=326474832151838730 \
  node scripts/audit-collect.ts     # ~118 requests, ~3 min, writes audit/raw/
node scripts/audit-report.ts        # no network, rebuilds every table
git diff audit/ data/               # what moved since last time
```

`audit-collect.ts` is the only part that touches Discord, and it can only issue
GET requests - there is no write helper in the file to reach for by accident.
`audit-report.ts` never touches the network, so the rubric can be changed and
re-run for free.

## Files

| File | What it is |
|---|---|
| `raw/*.json` | Verbatim API responses (guild, channels, roles, invites, welcome screen, onboarding, integrations, automod, forum threads) plus derived per-channel activity. The diff surface. |
| `raw/members.json` | **Aggregates only.** Join histogram, role headcounts, gate counts. No user ids, no names. |
| `raw/server_totals.json` | `A` - unique human authors server-wide, de-duplicated across every channel and thread, 30d and 90d. Two integers. |
| `channels.csv` | One row per channel: visibility, topic, 30/90-day traffic, verdict, and the number behind the verdict. |
| `categories.csv` | One row per category with its channels rolled up. |
| `roles.csv` | All 190 roles with a permission class, named dangerous permissions, and how many members hold each. |
| `role-consolidation.csv` | The per-role keep/merge/delete plan behind the `role-consolidation` document on TWO-55, plus the migration wave and whether a holder export is required. Rebuild with `node scripts/role-consolidation.ts` — no network, reads `raw/` only, so the rubric can be argued with and re-run for free. |
| `invites.csv` | Every active invite, uses, landing channel, inviter id. |
| `summary.json` | Headline counts plus the spec's server-level checks. |
| `new-member-walkthrough.txt` | The sidebar a brand-new member actually sees, in order. |

Two more files land outside this directory, at the contract paths from
`audit-spec` section 4:

| File | What it is |
|---|---|
| `../data/server-audit-<date>.csv` | One row per channel, spec 2.3 columns plus the verdict. What the reconfiguration plan in TWO-14 is built from. |
| `../data/server-audit-<date>.json` | The rollback source for the migration: every channel's topic, position, parent and full permission overwrites as they were at collection time, plus guild config, welcome screen, onboarding and all roles. |

`data/` is otherwise gitignored (it can hold generated reports and legacy
database files); the two snapshot files are explicitly un-ignored because they
are the point.

## Privacy

Message **content is never read**. `scanChannel` reduces each page of messages
to (author id, timestamp, is-bot) and throws the rest away; author ids stay in
memory only long enough to count distinct people, including for the server-wide
`A` figure. Members are never enumerated into a file - the census is reduced to
counts inside the collection loop, per spec 2.6. Nothing message-derived that
identifies a person is written to disk. This matches `docs/PRIVACY.md`.

Embedded user objects (invite inviters, integration users, integration
application bots) are reduced to `{ id }` by `scripts/audit-scrub.ts` before
anything is written - no usernames, avatars, or discriminators land in `raw/`.
`test/unit.auditscrub.test.ts` pins this over every tracked raw artifact, so a
new collector endpoint that embeds an identity fails the suite the day it lands.

## The rubric

From `audit-spec` section 3. Verdicts turn on **unique human authors**, not
message counts - "400 messages from 2 people is not a channel, it is a DM with
an audience". First matching rule wins.

| Verdict | Rule |
|---|---|
| `archive` | zero human messages in 90 days. Hide from `@everyone`, keep the history, never delete. |
| `keep` | >= 3 unique human authors in the last 30 days |
| `merge` | 1-2 unique human authors in 30 days. `merge_into` names the liveliest sibling in the same category. |
| `gate-behind-role` | a per-game or niche channel that is visible to everyone at join |
| `rewrite-topic` | visible and alive, but no topic is set |

`create` is a redesign decision, not an audit one, so it is out of scope here
(spec section 4: no recommendations beyond the per-channel verdicts).

### Two columns that make the verdicts safe to act on

The spec exempts nothing from `archive`, so the verdict column is the rule
applied as written. Two other columns carry the caveats instead:

- `visible_to_everyone` - most archives are bot logs and ticket transcripts
  already hidden from members. Archiving them changes nothing a member sees.
- `protected_by` - names the guild setting that points at this channel (rules
  channel, AFK channel, Server Guide default, welcome-screen card, public
  updates). Archiving one of these means repointing that setting first, in the
  same wave, or Community mode breaks.

**At TWO's current activity level the rubric collapses.** `A = 1` unique human
author server-wide in 30 days, so no channel can clear a `keep` bar of three
and 109 of 112 come back `archive`. That is the honest output, not a bug, and
it is why the two columns above exist.

### Known limits

- **Voice sessions are invisible over REST.** A voice channel's verdict is based
  on its text chat only, which is why twelve voice channels come back `archive`.
  Do not archive a voice channel on the strength of this data. Real voice
  numbers need the gateway listener in TWO-5.
- **Scan cap is 40 pages** (4,000 messages) per channel rather than the spec's
  2,000. One channel hit it and is marked `truncated` in the CSV.
- **Forum activity** is rolled up from threads. Threads that moved in the last
  90 days were scanned properly; older threads only contribute a last-activity
  date and their post/reply counts.
- Unique-author counts for forums are an upper bound (one person in two threads
  counts twice).
- **Channel ownership** (spec 3.7) is absent because Discord stores no such
  field. It needs a human answer.

# Server audit

A point-in-time, read-only inventory of the live TWO Discord server, kept in
the repo so the next audit is a `git diff` instead of a redo.

## Re-running it

```bash
DISCORD_TOKEN=<bot token> DISCORD_GUILD_ID=326474832151838730 \
  node scripts/audit-collect.ts     # ~120 requests, ~3 min, writes audit/raw/
node scripts/audit-report.ts        # no network, rebuilds the CSVs
git diff audit/                     # what moved since last time
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
| `channels.csv` | One row per channel: visibility, topic, 30/90-day traffic, verdict, and the number behind the verdict. |
| `categories.csv` | One row per category with its channels rolled up. |
| `roles.csv` | All 190 roles with a permission class and how many members hold each. |
| `invites.csv` | Every active invite, uses, landing channel, inviter id. |
| `summary.json` | The headline counts. |
| `new-member-walkthrough.txt` | The sidebar a brand-new member actually sees, in order. |

## Privacy

Message **content is never read**. `scanChannel` reduces each page of messages
to (author id, timestamp, is-bot) and throws the rest away; author ids stay in
memory only long enough to count distinct people. Nothing message-derived that
identifies a person is written to disk. The member census is reduced to counts
inside the collection loop for the same reason. This matches `docs/PRIVACY.md`.

## The rubric

Every channel gets exactly one verdict. First rule that matches wins, so the
order below is the rubric. "Human messages" excludes bots and webhooks, which
matters a lot here - bots outposted humans 5019 to 15 over the last 90 days.

| Verdict | Rule | Meaning |
|---|---|---|
| `gate-behind-role` | visible to @everyone, 0 human messages/90d, and it is a bot feed or ops room | Sidebar noise for a newcomer. Should sit behind a role. |
| `archive` | 0 messages of any kind in 90 days, and Discord's own config does not point new members at it | The room does nothing. |
| `rewrite-topic` | visible to @everyone, no topic set, and either protected or ≥10 human messages/90d | Kept, but a newcomer cannot tell what it is for. |
| `keep` (protected) | 0 messages/90d, but the welcome screen, Server Guide, rules, or AFK setting points here | Deleting it breaks the server's own configuration. |
| `keep` (bot feed) | 0 human messages, >0 bot messages, already hidden from @everyone | Working as intended. |
| `merge` | 1-9 human messages/90d | Real but too thin to hold its own room. |
| `keep` | everything else | |

Protected channels are read from the guild config, not hand-listed:
`rules_channel_id`, `public_updates_channel_id`, `safety_alerts_channel_id`,
`afk_channel_id`, every welcome-screen channel, and every
`onboarding.default_channel_ids` entry.

### Known limits

- **Voice sessions are invisible over REST.** A voice channel's verdict is based
  on its text chat only. The `#voice-log` bot feed (495 posts/90d) is the only
  proxy we have that voice is being used at all; real voice numbers need the
  gateway listener in TWO-5.
- **Forum activity** is rolled up from threads. Threads that moved in the last
  90 days were scanned properly; older threads only contribute a last-activity
  date.
- **`#❗〢audit-log` hit the 40-page scan cap** - its 4000 is a floor, not a count.
- Unique-author counts for forums are an upper bound (one person in two threads
  counts twice).

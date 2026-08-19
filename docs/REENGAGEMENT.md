# The weekly re-engagement list

Who we are losing, while we can still get them back. One command, once a week,
worked by a human.

```
npm run reengage -- --csv      # print the list and write data/reengagement-<date>.csv
npm run reengage -- --all      # include the lapsed tail by name
npm run reengage -- --mark     # record that the team has taken the list
```

Needs `DISCORD_GUILD_ID` and, for names, `DISCORD_TOKEN`. It reads the funnel
database and nothing else.

**Nothing here messages anybody.** It produces a list. Outbound contact — DMs,
pings, bulk anything — needs CEO sign-off before it is built, per
[PRIVACY.md](./PRIVACY.md). That is the whole point of doing it in this order:
a human works the list by hand first, and if that converts, we talk about
automating it. If it does not convert, we have saved ourselves an automated
system for annoying people.

## The four buckets

Printed in the order you should work them.

| Bucket | Who | Why here |
|---|---|---|
| `never_engaged` | Joined, never posted, never in a voice room | Never got in the door. The join already happened, so this is the cheapest growth there is. |
| `slipping` | Were active, quiet 21–60 days | The best chance of a save. Somebody who plays most weeks and has missed three is a signal, not a holiday. |
| `dormant` | Were active, quiet 60–240 days | Out of the habit. Worth an invite to a specific thing, not a general "we miss you". |
| `lapsed` | Quiet 240+ days | Lowest yield. Names are withheld unless you pass `--all`. |

Thresholds live in one place — `THRESHOLDS` in `src/jobs/reengagement.ts`. Change
them there and every report and test moves together.

## Three things the list deliberately does

**Voice counts as engagement.** TWO is voice-first: 15 human text messages in 90
days against 495 voice events. A member who has only ever been in voice is an
active member, and a list that called them "never engaged" would put most of the
real community on it.

**Raid accounts are set aside.** 30 of the 84 members still in the server arrived
in three mass-joins and have never done anything. They look exactly like a real
member who never posted, and they sort to the top of a naive query — so a team
working the list top-down would spend the week talking to bots. They are excluded
and counted on their own line, never quietly dropped. Windows are in
`src/analytics/anomalies.ts`.

**Members who joined in the last 3 days are left off.** Silence on day one is not
evidence of anything.

## NEW vs carried over

`--mark` writes a `member_inactive` event for everyone on the list. Next week
those names print with the date they were first handed over instead of `NEW`, so
the team can work new names first and does not re-contact the same person every
Monday. Without `--mark` you get the same list every week and no memory of who
has been tried.

Run it *after* the list has actually been handed to someone, not before.

## What is in the CSV, and what to do with it

`data/reengagement-<date>.csv` — segment, member ID, display name, profile link,
join date, where they came from, last seen, days quiet, whether it was voice or
text, and whether they have been listed before.

It contains display names, which the database deliberately does not. Names are
fetched from Discord at the moment the list is made and thrown away with the
file. `data/` is gitignored; **delete the CSV once the week's outreach is done.**

The list gives you facts, not a script. What to say to a member is the community
team's call, not the bot's.

## Known gap: "last seen" is only as good as the log

Recency comes from `last_active_at`, which moves on every message and every
voice join the bot sees, plus whatever the backfill could parse out of the log
channels. For members whose history predates the instrumentation, "last seen"
can be older than the truth. It gets more accurate every week the bot runs.

If a name on the list is a bot, an alt, or a staff account, say so and it gets
marked `is_bot` — it will never appear again.

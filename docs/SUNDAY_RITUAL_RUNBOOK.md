# Sunday ritual runbook + host script (pilot kit, part 2)

> DRAFT ONLY — docs only, no live-guild action, no scheduling, no member
> contact. For reviewer completeness check. Standalone part 2 of the
> event-ritual pilot; part 1 is the week-2 RSVP'd kit
> ([TOG-5121](/TOG/issues/TOG-5121), PR #183, unmerged at the time of writing).
> This file does not duplicate it: part 1 covers a single RSVP'd pilot
> instance (agenda + T-72h checklist + retro); this file is the reusable
> runbook for the recurring Sunday ritual — setup, host script, closeout —
> usable by any host, any Sunday, with zero week-specific content.

| | |
|---|---|
| Ritual | Sunday Squad — Fall Guys, Sundays 20:00–21:00 America/New_York |
| Room | 🔊🏠 Lobby voice (`1175127344072118405`) + event sidebar card |
| Cadence | Weekly; a party of two still drops into a full public show |
| Friction removers | Free game · no sign-up · come-as-you-are (no install needed — room games exist) |

Engineering authority is `docs/ANCHOR_EVENT.md` (wall-clock recurrence, routed
welcome, event-card script). Dated copy examples live in
`community/sunday-squad-event-2026-10-18.md` (post-pilot 18 Oct agenda) and
`community/welcome-post-refresh-pack3.md` (routed welcome wording). This
runbook is the operations layer between them: what a human does, in order.

## 1. Setup (once per Sunday, ~15 min, all human)

### 1a. Event card

- One card, named exactly `Sunday Squad`, on the Lobby voice channel,
  20:00–21:00 America/New_York. Recompute from the calendar date each week —
  never "+7 days / +604800 seconds" (drifts an hour at the US DST changeover;
  see `docs/ANCHOR_EVENT.md`).
- Preferred path: `node scripts/sunday-squad-event.ts --dry-run` first, then
  the live run. The script PATCHes the existing same-name card rather than
  adding a second — two Sunday Squads in the sidebar splits the room.
- If the guild refuses `recurrence_rule`: `--individual` for one-off cards,
  topped up by hand. Six real cards beat one recurring card on the wrong week.
- Description (stable series text — keep identical week to week so the series
  reads as one event, not a relaunch):

```text
Fall Guys, an hour, every Sunday. It runs whether there's two of us or eight — a party of two still drops into a full public show. Free on PC, PlayStation, Xbox, Switch and Android, and nothing to be rusty at.

Drop in whenever. No sign-up, no need to say you're coming, and if you haven't got it installed there's something we can play in the room itself.
```

### 1b. Morning announcement (landing channel, day-of)

Post once, morning of. No @everyone — audience is whoever is already around;
mention policy stays with the CPO.

```text
🎮 **Sunday Squad — tonight, 8pm Eastern**

One hour of Fall Guys in the 🔊🏠 Lobby, every Sunday. Zero sign-up, zero skill required. Brought a friend? Even better — there's always room for one more in the party.

Just hop into the Lobby voice room at 8. See you there. 👑
```

### 1c. Host pre-flight (T-30 min)

- [ ] Host in voice 5 min early (19:55 ET); game client open, party lobby ready.
- [ ] Backup identified (any regular who can pull arrivals into the party if
      the host's mic/client dies — no formal rota, just a name).
- [ ] Recap line owner named: who drops the one-line recap for Monday's post
      (host by default).

## 2. Host script (60 min, paste-ready lines)

| Time (ET) | Beat | Say / do |
|---|---|---|
| 20:00–20:10 | Doors + party fill | Pull arrivals straight into the party, no waiting room. Greet by voice: *"Hey {name}, glad you made it — we're queuing the next show, you're in."* Late joiners slot in between rounds all hour. |
| 20:10–20:45 | Main block | Queue shows back-to-back. Between rounds, one line for newcomers: *"First time? Just follow the crowd — nothing to be rusty at."* No speeches, no rules lecture. |
| 20:45–20:55 | Last rounds + shout-outs | *"Last couple of shows, then we wrap."* Name first-timers, thank returners by voice (no list needed, no leaderboard). |
| 20:55–21:00 | Wrap | Close with the continuity line: *"Same time next week — Sunday, 8pm, right here."* Host notes the recap line (headcount feel + one factual moment) for Monday's post. |

What the host does NOT do: no DMs to pull people in, no @everyone, no
sign-up sheet, no skill gating, no presenting bot output as conversation. A
quiet two-person hour is a held ritual, not a failed event — report it as-is.

## 3. Closeout (+0–48h)

### 3a. Night-of (host, 5 min)

- Drop the recap line in the host channel/notes: date, rough headcount,
  first-timer count, one factual moment. Facts only — no invented attendance,
  no reconstructed quotes.

### 3b. Monday follow-up (one post, landing channel)

```text
👑 **Sunday Squad — last night**

{one factual line — e.g. "Six of us, two first-timers, zero crowns but one photo finish."}

Same time next Sunday, 8pm Eastern in the 🔊🏠 Lobby. Bring a friend. 🎮
```

- Quiet weeks post the quiet version (*"Small room last night — the ritual
  holds. Same time next Sunday."*). Never skip the post: the Monday line is
  what makes it a ritual rather than a one-off.
- Cadence guard: the contributor spotlight
  (`community/contributor-spotlight-template.md`) never posts adjacent to a
  Squad announcement day — spotlight bows to the ritual.

### 3c. Pilot evidence (per week, one row in the notes doc)

Date · host + backup names · rough headcount · first-timer count · recap
posted (Y/N + link) · issues (mic/client failure, empty room, disruption).
This row is the 7-day metric feed: sessions held from this kit.

## 4. Acceptance for this file

- Reviewer confirms completeness: setup (§1), host script (§2), and closeout
  (§3) are each host-executable with no missing step, no week-specific values
  baked in, scheduling note consistent with `docs/ANCHOR_EVENT.md`, and no
  live-guild action implied anywhere.
- On acceptance: kit frozen at that revision. Week-specific copy stays in
  `community/` dated files; any change here after acceptance is a new revision.

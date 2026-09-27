# TWO event-ritual pilot — week-1 kit: agenda template + host checklist

Status: **DRAFT, docs only** — pending CPO acceptance as pilot-ready.
No live-guild action, no scheduling, no member contact on this card.

- Parent pilot: [TOG-1964](/TOG/issues/TOG-1964) (blocked on [TOG-2326](/TOG/issues/TOG-2326); nothing here unblocks or executes it).
- Builds on: [TOG-4674](/TOG/issues/TOG-4674) host criteria + copy drafts (announcement / reminder / recap with placeholders; Content Producer finalizes).
- Source constraints: one in-server announcement, one RSVP action, opted-in reminder only, truthful 24–48h follow-up, no unsolicited DMs/mass messaging, canonical [TOG-1649](/TOG/issues/TOG-1649) RSVP/attendance primitives only, bot noise <20%, bot stays labeled.

## 0. Placeholders — fill only from 5+ first-party responses on TOG-1964

Do not fix any of these on this card. Collection happens on [TOG-1964](/TOG/issues/TOG-1964) after unblock; record exact member language + confidence there.

`[TOPIC]` · `[DAY, TIME + TIMEZONE]` (wall-clock, see §4) · `[DURATION: 60/75/90]`
`[HOST]` · `[BACKUP]` · `[CHANNEL]` · `[RSVP-ACTION — canonical only]` · `[PARTICIPATION-PROMPT]`

## 1. Agenda template (60-minute default; 90-minute extension below)

| Clock | Block | Owner | Notes |
|---|---|---|---|
| 0:00–0:05 | Doors / landing | Host | Early arrivals settle; backup confirms notes doc is open. No content yet. |
| 0:05–0:15 | Welcome + intros | Host | Each person: handle + one-line answer to `[PARTICIPATION-PROMPT]`. Host goes first to model brevity. Name the shape: weekly, same slot, 4 weeks. |
| 0:15–0:40 | Core activity | Host facilitates, backup captures | Topic-shaped discussion / exercise around `[TOPIC]`. Host keeps turns short; backup logs aggregate points only (no verbatim quotes without consent). |
| 0:40–0:50 | Share-out: wins & stucks | Host | Go round-robin; pass allowed. One win + one stuck per person, 1 minute each. |
| 0:50–0:55 | Close | Host | Thank everyone; confirm same slot next week; recap lands in `[CHANNEL]` within 48h either way; one feedback question: "what almost stopped you from joining?" |
| 0:55–1:00 | Buffer / hard stop | Host | Overrun guard. Host ends on time even mid-thread; unfinished items roll to next week. |

**90-minute extension** (use only if the 5+ responses confirm 90): core activity expands to 0:15–1:00 with a 10-minute break at 0:45; share-out 1:00–1:20; close 1:20–1:30.

**First-timers:** welcomed by name in intros, never singled out for extra turns. **Returners:** acknowledged, not tasked (no on-the-spot hosting asks). **What the host does NOT do:** no DMs, no second RSVP path, no presenting bot output as human conversation, no attendance/quote inflation, no freelance moderation (escalate disruption to CM/mods per existing server process).

## 2. Host checklist

### T-72h
- [ ] Host + backup confirm availability for the same slot; backup reachable on event day.
- [ ] Single in-server announcement posted (final Content Producer copy); `[RSVP-ACTION]` verified live and canonical-only.

### T-24h — go / no-go
- [ ] Count RSVPs. **Fewer than 3 → cancel this instance**: post the cancellation note ("Week [N] cancelled ([N] RSVPs, needed 3). Next try: [DAY/TIME]."), notify backup, log the count truthfully. No substitute drafted same-day.
- [ ] 3+ → confirm host/backup, prep `[PARTICIPATION-PROMPT]` + notes doc, verify channel/voice access.

### T-1h to doors
- [ ] Notes doc open; attendance proof method ready (canonical [TOG-1649](/TOG/issues/TOG-1649) method — **RSVP is not attendance**).
- [ ] Any automation labeled; reminder sent **only** to RSVP-yes / "remind me" replies.

### During
- [ ] Run the agenda; hard stop on time.
- [ ] Record attendance only via the canonical proof method; record host/backup staff/non-staff status.
- [ ] Backup captures aggregate notes; no verbatim quotes without explicit consent.

### +0–2h
- [ ] Host + backup debrief (what worked, headcount, issues) in the notes doc.

### +24–48h — truthful follow-up (one post)
- [ ] Recap posted: eligible attendance `[N]` + proof method; first-timer/returner split only if computable, else omit; 1–2 factual aggregate lines; next-slot line with `[RSVP-ACTION]`.
- [ ] Quiet or cancelled weeks reported as-is. Never invent attendance, quotes, or activity. Named thanks only with separate recap opt-in (first name/handle per their choice).

### Kill / pivot (per brief — host enforces, CM owns the call)
- Cancel an instance under 3 RSVPs at T-24h; change topic/time after two sub-5 events; end the format if fewer than two non-staff humans return or nobody will host/help.

### Instrumentation to record each week (pilot evidence)
Event created · RSVP transitions · eligible attendance + proof method · first-time/returning split (if computable) · follow-up posted (Y/N + link) · event-linked eligible messages · host/backup names + staff/non-staff flags · bot-noise check (<20%).

## 3. Copy wiring

Announcement / opted-in reminder / recap drafts live in [TOG-4674](/TOG/issues/TOG-4674) §2. This kit does not duplicate them — the host pastes the finalized Content Producer copy at the marked slots. Bracketed fields stay bracketed until member inputs land.

## 4. Scheduling note (Sunday Squad lesson)

Fix the slot as **wall-clock in a named timezone** (e.g. "Sundays 20:00 America/New_York"), never as a UTC instant or "+7 days" interval — a fixed 604800-second step drifts an hour at the US DST changeover (see `docs/ANCHOR_EVENT.md`). Recompute each occurrence from its calendar date.

## 5. Acceptance

CPO accepts this kit as pilot-ready → kit frozen at that revision. Values are filled only after [TOG-1964](/TOG/issues/TOG-1964) unblocks and 5+ member responses are recorded. Any change after acceptance is a new revision requiring re-acceptance.

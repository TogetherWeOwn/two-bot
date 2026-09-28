# TWO event-ritual pilot — week-2 kit: agenda template + host checklist + retro template

Status: **DRAFT, docs only** — pending CPO acceptance as pilot-ready.
No live-guild action, no scheduling, no member contact on this card.

- Parent pilot: [TOG-1964](/TOG/issues/TOG-1964) (blocked on [TOG-2326](/TOG/issues/TOG-2326); nothing here unblocks or executes it).
- Mirrors: week-1 kit ([TOG-4884](/TOG/issues/TOG-4884), rev `ac85683`, not yet merged — re-align if week 1 changes at acceptance).
- Extends: [TOG-5080](/TOG/issues/TOG-5080) week-2 draft (agenda + checklist, commit `c2595d4`, unmerged — push blocked at the time). This kit carries that content forward unchanged and adds the retro template (§6); this branch is the merge vehicle.
- Builds on: [TOG-4674](/TOG/issues/TOG-4674) host criteria + copy drafts (announcement / reminder / recap with placeholders; Content Producer finalizes).
- Source constraints: one in-server announcement, one RSVP action, opted-in reminder only, truthful 24–48h follow-up, no unsolicited DMs/mass messaging, canonical [TOG-1649](/TOG/issues/TOG-1649) RSVP/attendance primitives only, bot noise <20%, bot stays labeled.

## 0. Placeholders — fill only from 5+ first-party responses on TOG-1964

Do not fix any of these on this card. Collection happens on [TOG-1964](/TOG/issues/TOG-1964) after unblock; record exact member language + confidence there.

`[TOPIC]` · `[DAY, TIME + TIMEZONE]` (wall-clock, see §4) · `[DURATION: 60/75/90]`
`[HOST]` · `[BACKUP]` · `[CHANNEL]` · `[RSVP-ACTION — canonical only]` · `[PARTICIPATION-PROMPT]`
`[WEEK-1-RECAP-LINK]` (posted recap, for the continuity bridge — never reconstructed from memory)

## 1. Agenda template (60-minute default; 90-minute extension below)

Week 2 continues the ritual, it does not relaunch it. The through-line is: same slot, same shape, deeper topic.

| Clock | Block | Owner | Notes |
|---|---|---|---|
| 0:00–0:05 | Doors / landing | Host | Early arrivals settle; backup has the week-1 notes + posted recap open. No content yet. |
| 0:05–0:10 | Week-1 bridge | Host | One factual recap line from `[WEEK-1-RECAP-LINK]` (what happened, not what it meant) + the week-2 through-line: "last week we surfaced X; today we go deeper on `[TOPIC]` part 2." Never re-run week 1. |
| 0:10–0:18 | Intros, two-track | Host | Returners: handle + one-word check-in. Newcomers: handle + one-line answer to `[PARTICIPATION-PROMPT]`; host gives a 30-second catch-up on what they missed (the room does not). |
| 0:18–0:43 | Core activity, deeper | Host facilitates, backup captures | Builds directly on week-1 output: revisit last week's stucks, advance `[TOPIC]`. Host keeps turns short; backup logs aggregate points only (no verbatim quotes without consent). |
| 0:43–0:52 | Share-out: wins, stucks & deltas | Host | Round-robin; pass allowed. Returners add: "what changed since last week?" Newcomers: one win + one stuck, 1 minute each. |
| 0:52–0:57 | Close + midpoint lookahead | Host | Thank everyone; confirm weeks 3–4 same slot; recap lands in `[CHANNEL]` within 48h either way; one feedback question: "what would make next week worth your time?" |
| 0:57–1:00 | Buffer / hard stop | Host | Overrun guard. Host ends on time even mid-thread; unfinished items roll to week 3. |

**90-minute extension** (use only if the 5+ responses confirm 90): bridge + intros unchanged; core activity expands to 0:18–1:03 with a 10-minute break at ~0:48; share-out 1:03–1:20; close 1:20–1:30.

**Newcomers:** welcomed by name, given the catch-up, never quizzed on week-1 content, never singled out for extra turns. **Returners:** acknowledged by name, not tasked (no on-the-spot hosting asks). **What the host does NOT do:** no DMs, no second RSVP path, no presenting bot output as human conversation, no attendance/quote inflation, no week-1 re-run for latecomers, no freelance moderation (escalate disruption to CM/mods per existing server process).

## 2. Host checklist

### T-72h
- [ ] Host + backup confirm availability for the same slot; backup reachable on event day.
- [ ] Host re-reads week-1 notes + posted recap; carries open stucks forward into the core-activity plan.
- [ ] Single in-server announcement posted (final Content Producer week-2 copy — continuity line references the posted recap only, never invented attendance); `[RSVP-ACTION]` verified live and canonical-only.

### T-24h — go / no-go
- [ ] Count RSVPs. **Fewer than 3 → cancel this instance**: post the cancellation note ("Week [N] cancelled ([N] RSVPs, needed 3). Next try: [DAY/TIME]."), notify backup, log the count truthfully. No substitute drafted same-day.
- [ ] 3+ → confirm host/backup, prep the 30-second newcomer catch-up + `[PARTICIPATION-PROMPT]` + notes doc (week-1 summary pasted at top), verify channel/voice access.
- [ ] Log RSVP count alongside week 1 for the record only — no spin, no lowering the bar.

### T-1h to doors
- [ ] Notes doc open with week-1 summary at top; attendance proof method ready (canonical [TOG-1649](/TOG/issues/TOG-1649) method — **RSVP is not attendance**).
- [ ] Any automation labeled; reminder sent **only** to RSVP-yes / "remind me" replies.

### During
- [ ] Run the agenda; hard stop on time.
- [ ] Record attendance only via the canonical proof method; record host/backup staff/non-staff status; tag returner vs newcomer only if computable via the canonical method, else omit.
- [ ] Backup captures aggregate notes; no verbatim quotes without explicit consent.

### +0–2h
- [ ] Host + backup debrief (what worked, headcount, issues) in the notes doc, including the factual week-over-week comparison (RSVP delta, return count, newcomer count).

### +24–48h — truthful follow-up (one post)
- [ ] Recap posted: eligible attendance `[N]` + proof method; returner/newcomer split only if computable, else omit; 1–2 factual aggregate lines including one continuity line vs week 1; next-slot line with `[RSVP-ACTION]`.
- [ ] Fill the retro template (§6) in the notes doc alongside the recap.
- [ ] Quiet or cancelled weeks reported as-is. Never invent attendance, quotes, or activity. Named thanks only with separate recap opt-in (first name/handle per their choice).

### Kill / pivot (per brief — host enforces, CM owns the call)
- Cancel an instance under 3 RSVPs at T-24h; change topic/time after two sub-5 events; end the format if fewer than two non-staff humans return or nobody will host/help.
- Week 2 is the second data point for the "two sub-5 events" and "fewer than two non-staff humans return" signals — the host records them, the CM makes the call. The host never pivots the format mid-pilot.

### Instrumentation to record each week (pilot evidence)
Event created · RSVP transitions · eligible attendance + proof method · first-time/returning split (if computable) · week-1→week-2 return count + newcomer count · follow-up posted (Y/N + link) · event-linked eligible messages · host/backup names + staff/non-staff flags · bot-noise check (<20%).

## 3. Copy wiring

Announcement / opted-in reminder / recap drafts live in [TOG-4674](/TOG/issues/TOG-4674) §2. This kit does not duplicate them — the host pastes the finalized Content Producer copy (week-2 variant) at the marked slots. Bracketed fields stay bracketed until member inputs land. The week-2 announcement's continuity line cites `[WEEK-1-RECAP-LINK]`, never host memory.

## 4. Scheduling note (Sunday Squad lesson)

Fix the slot as **wall-clock in a named timezone** (e.g. "Sundays 20:00 America/New_York"), never as a UTC instant or "+7 days" interval — a fixed 604800-second step drifts an hour at the US DST changeover (see `docs/ANCHOR_EVENT.md`). Recompute each occurrence from its calendar date. Week 2 is the same wall-clock slot as week 1, not "week 1 + 604800 seconds".

## 5. Acceptance

CPO accepts this kit (agenda + checklist + retro template) as pilot-ready → kit frozen at that revision. Values are filled only after [TOG-1964](/TOG/issues/TOG-1964) unblocks and 5+ member responses are recorded. Any change after acceptance is a new revision requiring re-acceptance.

## 6. Retro template (fill after week 2, before week 3)

Paste into the notes doc; the host fills it within +48h, alongside the recap (§2). Facts only — no reconstructed quotes, no spin. If week 2 was cancelled, fill only the first three lines and the carry-forward line.

```text
Week-2 retro — [DATE]
Host: [HOST] (staff/non-staff: _) · Backup: [BACKUP] (staff/non-staff: _)
RSVPs at T-24h: [N] (go / cancelled: _)
Eligible attendance: [N] + proof method: [METHOD]
Returners (week-1→week-2): [N or "not computable"] · Newcomers: [N or "not computable"]
Follow-up posted: [Y/N + link]
Event-linked eligible messages (week-2 window): [N or omit]
Bot-noise check: [<20% Y/N]

What worked (1–2 factual lines):
-
What didn't (1–2 factual lines):
-
Week-over-week delta (RSVP / attendance / return vs week 1):
-
Carry into week 3 (open stucks, max 3):
1.
2.
3.
Kill/pivot signals to flag to the CM (record only — the CM owns the call):
- Sub-5 event count so far: [_ of 2]
- Non-staff humans who returned week-1→week-2: [_; flag if <2]
- Host/backup availability for week 3: [Y/N + names]
```

Rules: aggregate points only; verbatim quotes only with explicit consent; quiet or cancelled weeks reported as-is. The host never pivots the format on retro findings — the retro feeds the CM's week-3 call.

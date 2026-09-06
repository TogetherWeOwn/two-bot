# Sunday Squad: the routed welcome and the recurring event

TOG-93. The spec is `anchor-event-and-first-72-hours` on TWO-66, **revision 4**
(`dc192d46-22fe-420b-9cc9-8945b722b60e`). Revisions 2 and 3 name Fortnite and
are dead — the CEO settled on Fall Guys on 2026-08-19. If you are reading an
older revision, stop.

| | |
| --- | --- |
| Event | `Sunday Squad` |
| When | Sundays, **20:00 America/New_York**, 60 minutes |
| Room | `🔊🏠〢Lobby` voice, `1175127344072118405` |
| Game | Fall Guys (free) |
| First run | Sunday 23 August 2026, epoch `1787529600` |

## The one thing that will bite you

**The recurrence is a wall-clock time, not an interval.** Sunday Squad is 20:00
in New York. Adding 604800 seconds to the previous occurrence is correct for 51
weeks a year and silently an hour wrong from **1 November 2026**, when US DST
ends. An event card that reads 19:00 looks fine in the sidebar and is wrong, and
nobody notices until the room is empty at eight.

So every occurrence in `src/onboarding/anchorEvent.ts` is computed from its own
calendar date as a wall time in the event's own zone and converted to an instant
afterwards. `test/unit.anchorevent.test.ts` walks 30 consecutive Sundays across
both changeovers and asserts each one reads 20:00 locally, and asserts the
DST week is 169 hours rather than 168.

The same tests pin the six epochs the Community Manager published, so this is
checked against the spec and not against our own arithmetic:

`1787529600` · `1788134400` · `1788739200` · `1789344000` · `1789948800` · `1790553600`

Nothing anywhere stores "the next Sunday Squad". There is no date to go stale.

## 1. The routed welcome

One message, posted into the Lobby's text chat the moment a member's rules
screening flag clears. It names the next occurrence with a relative `<t:…:R>`
timestamp, so it reads "in 3 days" in the reader's own timezone without us
knowing what that is.

- The decision to post is `decidePrompt()` in `src/onboarding/flow.ts`,
  **unchanged**. That is where the wait-for-`pending` rule and the
  once-per-member guard live, and both were already right.
- The adapter is `src/discord/anchorWelcome.ts`. It emits `onboarding_prompted`
  and `channel_routed`, in that order, and **only after the message is actually
  out** — emitting first would let a failed post still count as a routed member.
- **Nothing may be appended to that message.** No picker, no buttons, no footer.
  That is an instruction in TOG-93, not a preference.
- The copy has two voices. Normal, and a near-event variant that replaces the
  second paragraph when the join lands less than two hours before an occurrence.

### Which occurrence gets named

The spec states one rule — "less than two hours before an occurrence" — and
writes the near-event copy in the present tense ("happening right now … for
about another hour"). Taken literally, the rule alone leaves a member who joins
at 20:30 being told about *next* Sunday while Sunday Squad is audibly running in
the very room the message appears in. So an occurrence still in progress counts
as near too, and is the one we name.

That is the only judgement call in the implementation; everything else is
transcription. If the Community Manager wants the literal reading instead, it is
the `live` branch of `occurrenceContext()` and nothing else.

### Turning it on

```
DISCORD_ANCHOR_WELCOME_CHANNEL_ID=1175127344072118405
```

Setting this **moves** the rules-gate-clear moment. Exactly one thing may own
it: `onboarding_prompted` is once-per-member by design, so if both the anchor
welcome and the game picker's own welcome were registered, whichever handler ran
first would silently starve the other. With the flag set, the anchor welcome
greets and the picker keeps working without greeting. With it unset the bot
behaves exactly as it did before TOG-93 — which is the point of it being one
flag rather than a rewrite. It has to be reversible in seconds on a live server
if the copy lands badly.

## 2. The recurring scheduled event

```
node scripts/sunday-squad-event.ts --dry-run          # no token needed
DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=… node scripts/sunday-squad-event.ts
```

Idempotent: it finds an existing event of the same name and PATCHes it rather
than adding a second card. Two Sunday Squads in the sidebar is worse than none,
because people pick the wrong one and then do not come.

**Run 1 remains the series anchor in the spec.** Before it begins, the script
uses 23 August rather than the old 30 August value. Once that anchor is in the
past, Discord cannot create the missed card retroactively, so the live script
advances to the next independently-computed Sunday at 20:00 New York time. It
does not shift the cadence or add 604800 seconds across the DST boundary.

If the guild refuses `recurrence_rule`, the script says so and names the remedy:

```
node scripts/sunday-squad-event.ts --individual       # six one-off cards
```

Six real cards topped up by hand beat one recurring card on the wrong week. The
CM has offered to keep them topped up.

## What is not done here

Neither half has run against a live server. TOG-93 is blocked on **TOG-13** (the
live bot token and a host). Everything above is verified against the mock
Discord in `tools/mock-discord` and by unit tests; the first real occurrence of
either is a deploy-day check. See the acceptance list on TOG-93.

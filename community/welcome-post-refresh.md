# Welcome-post refresh (routed Sunday Squad welcome)

> DRAFT ONLY — copy proposal, no bot change. For CPO copy approval; engineering
> handoff follows approval. Must stay within the TOG-93 constraints: **one
> message, nothing appended** (no picker, buttons, or footer), posted in the
> Lobby's text chat the moment the rules gate clears.

| | |
|---|---|
| Intended channel | 🔊🏠 Lobby text chat (`1175127344072118405`) — the room the member arrived in |
| Intended use | Routed welcome at gate-clear, naming the next pilot occurrence |
| Pilot window | Joins from Sat 26 Sep through Sun 11 Oct 2026 name the upcoming pilot run |

## Proposed copy — normal voice (join lands >2h before the event)

```text
Hey @member — glad you're here.

The thing to know: **Sunday Squad**, every Sunday at 8pm Eastern in <#1175127344072118405>. We play Fall Guys for about an hour. Next one is <t:NEXT:R>.

You don't need to sign up or say anything first — just join the voice room and I'll get you into the party. Haven't got Fall Guys? Come anyway, there's something we can play right there in the room. If you can't make Sunday, hop in whenever and see who's about.
```

(`<t:NEXT:R>` renders as "in 3 days" etc. in the reader's own timezone.)

## Proposed copy — near-event voice (join lands <2h before, or mid-event)

```text
Hey @member — glad you're here.

The thing to know: **Sunday Squad** is happening right now in <#1175127344072118405> — Fall Guys, for about another hour. Come say hi. You don't need it installed to join in.

You don't need to sign up or say anything first — just join the voice room and I'll get you into the party. Haven't got Fall Guys? Come anyway, there's something we can play right there in the room. If you can't make Sunday, hop in whenever and see who's about.
```

## What changed vs. the current live welcome

1. **Pilot-aware first impression:** the event is named in the first thing a new
   member reads, tied to the three pilot dates (27 Sep, 4 Oct, 11 Oct) via the
   computed next-occurrence timestamp — no stale dates, same as today.
2. **Warmer open, same structure:** "glad you're here" stays; middle paragraph
   keeps the spec's two voices (normal / near-event) so the bot logic
   (`occurrenceContext()` in `src/onboarding/anchorEvent.ts`) needs no change —
   only the wrapped wording is up for approval.
3. **Nothing appended:** still one message, no buttons, no picker, no footer —
   the TOG-93 rule is preserved.

## Acceptance for this file

- CPO approves both voices above.
- On approval, engineering copies the approved text into `anchorWelcomeText()`
  (spec TWO-66 §5.3 remains the authority; any deviation needs a spec revision).

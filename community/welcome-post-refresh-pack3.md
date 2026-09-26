# Welcome-post refresh, pack 3 (post-pilot regular run)

> DRAFT ONLY — copy proposal, no bot change. For CPO copy approval; engineering
> handoff follows approval. Follow-up to [TOG-4823](/TOG/issues/TOG-4823)
> (pilot welcome) and [TOG-4935](/TOG/issues/TOG-4935) (sequence pack, draft).
> Must stay within the TOG-93 constraints: **one message, nothing appended**
> (no picker, buttons, or footer), posted in the Lobby's text chat the moment
> the rules gate clears. No live-guild action.

| | |
|---|---|
| Intended channel | 🔊🏠 Lobby text chat (`1175127344072118405`) — the room the member arrived in |
| Intended use | Routed welcome at gate-clear, post-pilot wording (from Mon 12 Oct 2026) |
| What changes vs. pack 1 | Pilot dates gone; event named as an ongoing weekly ritual |

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

## What changed vs. the pack-1 pilot welcome

1. **No pilot window:** the "three pilot dates" framing is retired. The computed
   next-occurrence timestamp (`occurrenceContext()` in
   `src/onboarding/anchorEvent.ts`) keeps working unchanged — it never stored
   dates, so no logic change is needed, only this copy.
2. **Same structure, same voices:** normal / near-event split preserved so the
   bot logic needs no change — only the wrapped wording is up for approval.
3. **Nothing appended:** still one message, no buttons, no picker, no footer —
   the TOG-93 rule is preserved.

## Acceptance for this file

- CPO approves both voices above.
- On approval, engineering copies the approved text into `anchorWelcomeText()`
  (spec TWO-66 §5.3 remains the authority; any deviation needs a spec revision).

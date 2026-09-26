# Community FAQ refresh (source copy, pack 2)

> DRAFT ONLY — copy proposal. No page built, nothing posted, no bot change.
> For CPO copy approval. Follow-up to [TOG-4823](/TOG/issues/TOG-4823)
> (in_review). No live-guild action.
>
> This file is the source of truth. The short help post
> (`docs/COMMUNITY_HELP_POST.md`, same pack) is the pinned summary of it.
> CPO picks the member-visible home: two-web FAQ page or second pinned post.

## FAQ — paste-ready copy

### How do I get started?

Read the welcome message in the landing channel, then use the picker under it:
🎲 **Find people to play with** or 🔊 **Join voice now**. Tap one and the bot
points you at the right room. It picks tonight's destination, not a forever
label — pick again any time you change your mind.

### Does the bot give me a role?

No. Nothing in the welcome flow grants, removes, or needs a role. If you can
see a room, you can join it; if you can't see it, the bot won't send you there.

### Will the bot DM me?

No. The bot posts in the landing channel, answers your picker tap in a reply
only you can see, and posts a goodbye when someone leaves. It never sends DMs.

### I tapped the picker and nothing happened / the room won't open. What now?

Rooms are checked against your own permissions at tap time, so if a destination
isn't open to you right now you'll get a "not open to you" answer and nothing
changes. Wait a moment and try again — or just say hello in the landing channel
and a human will grab you.

### What is Sunday Squad?

Our weekly ritual: about an hour of Fall Guys, every Sunday at 8pm Eastern in
the Lobby voice room. No sign-up, no experience needed, every week starts from
zero. Check the Events tab for the next confirmed date.

### Do I need Fall Guys installed?

No — come anyway. There's always something playable in the room itself, and
Fall Guys is free on PC, PlayStation, Xbox, Switch, and Android if you want it
later.

### Do I have to sign up or say I'm coming?

No. Just join the voice room at 8. Showing up *is* the sign-up.

### What happens if I leave the server?

The bot posts a plain goodbye ("X left the server") — no guilt trip, no
retention pitch. Your messages and voice history stay on the books.

### Who runs this place, and where do the numbers go?

Humans run the community; the bot only routes and counts. It logs anonymous
funnel events (joined, welcomed, routed) to measure whether newcomers get a
first reply — never message contents, never your user ID in the clear.

## Why this FAQ

- Every answer is traceable to shipped code (accuracy notes below), not vibes —
  the last FAQ-style content in the tree was pack-1-era welcome copy, and there
  is no existing FAQ file to contradict.
- Short version (help post) and long version (this file) ship together so the
  pinned post never drifts from the source answers.
- Sunday Squad answers repeat the pilot's friction removers without hard-coding
  pilot dates, so this FAQ stays true whether CPO approves pack 1 as-is or
  revises it.

## Accuracy notes (verified, not invented)

- Picker options/descriptions: `src/onboarding/session.ts:49-65`.
- Welcome wording: `src/onboarding/session.ts:80-86`.
- No roles / no DMs / permission-checked destinations:
  `src/discord/sessionWelcome.ts:10-18`, member check at `:91-96`.
- Picker reply visible only to clicker: `src/discord/sessionWelcome.ts:212`
  plus `sessionAckText` at `src/onboarding/session.ts:148-163`.
- Rooms-closed wording: `src/onboarding/session.ts:156-160`.
- Goodbye wording: `src/onboarding/session.ts:171-178`.
- "No sign-up, just join voice" matches the approved pack-1 event drafts
  (commit `9dc63fc`, `community/` on the pack-1 branch).
- No `faq`/`help-post` file exists anywhere in the two-bot tree (grep across
  `*.md` empty) — this file establishes the FAQ.

## Welcome-flow link proposal (needs CPO pick, then engineering if B)

- **Option A (no code change, shippable on merge):** pin the help post beside
  the welcome; this FAQ lives at its CPO-chosen home (two-web page or second
  pinned post) and the help post points at it.
- **Option B (one-line bot change):** append `Stuck? See the pinned help post 👆`
  to the welcome text. Touches the TOG-93 one-message shape — needs explicit
  CPO blessing plus an engineering handoff.
- Recommended: ship A now, decide B with the week-4 metrics read.

## Acceptance for this file

- CPO approves the Q&A above and picks the member-visible home (two-web page
  or pinned post) plus A (or A+B) for the welcome link.
- On approval: merge, publish to the chosen home, fill the help post's
  `<link added on publish>` placeholder.

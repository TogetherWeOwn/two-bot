# Help-post draft (pinned-post copy, pack 2)

> DRAFT ONLY — copy proposal. Nothing posted, nothing pinned, no bot change.
> For CPO copy approval. Follow-up to [TOG-4823](/TOG/issues/TOG-4823)
> (in_review). No live-guild action.

| | |
|---|---|
| Intended channel | Landing text channel, pinned beside the welcome post |
| Intended use | "Need a hand?" pinned post: the first thing a confused newcomer reads |
| Source of truth | `docs/COMMUNITY_FAQ.md` (same pack) — this post is the short version |
| Member-visible FAQ home | TBD by CPO: two-web FAQ page or a second pinned post; this pack is the source copy either way |

## Paste-ready copy

```text
👋 New here? Start here.

**1. Pick what you want to do.** Under the welcome message there's a picker with two options: 🎲 Find people to play with, or 🔊 Join voice now. Tap one and I'll point you at the right room. Changed your mind? Pick again any time — it chooses tonight's destination, not a forever label.

**2. No roles, no sign-ups, no DMs from me.** I never hand out roles and I never DM you. Tapping the picker answers back in a reply only you can see.

**3. Stuck? Just say hello.** If a room won't open for you, say hi in this channel and a human will grab you.

**4. Same time every week:** **Sunday Squad**, Sundays 8pm Eastern — about an hour of Fall Guys, zero sign-up. Check the Events tab for the next confirmed date.

Longer answers live in the FAQ: <link added on publish>.
```

## Why this copy

- Mirrors the live welcome's own words ("tonight, not a label forever") so the
  post and the bot never contradict each other.
- Leads with the single action a newcomer can take (the picker), not rules.
- States the two trust facts up front (no roles, no DMs) — the things new
  members are most suspicious of.
- Sunday Squad line repeats the pilot's three friction removers (weekly, free
  game, no sign-up) without hard-coding pilot dates, so it stays true whatever
  CPO approves in pack 1.

## Accuracy notes (verified, not invented)

- Two picker options + descriptions: `src/onboarding/session.ts:49-65`.
- "Tonight, not a label forever" paraphrases `sessionWelcomeText`,
  `src/onboarding/session.ts:80-86`.
- No roles / no DMs: `src/discord/sessionWelcome.ts:10-18`.
- Picker reply visible only to the clicker: `src/discord/sessionWelcome.ts:212`
  (ephemeral defer) + `src/onboarding/session.ts:148-163`.
- "Say hello and someone will grab you" matches the rooms-closed ack,
  `src/onboarding/session.ts:156-160`.
- No FAQ exists anywhere in the two-bot tree today (grep for faq/help-post
  across `*.md` returns nothing) — the FAQ file in this pack establishes it.

## Welcome-flow link proposal (needs CPO pick, then engineering)

- **Option A (no code change):** pin this post in the landing channel; the
  welcome flow "links" to it by proximity. Shippable on merge.
- **Option B (one-line bot change):** append `Stuck? See the pinned help post 👆`
  to the welcome text. Needs engineering handoff after approval; note it touches
  the TOG-93 one-message shape, so CPO must explicitly bless it.
- Recommended: ship A now, decide B with the week-4 metrics read.

## Acceptance for this file

- CPO approves the paste-ready copy above and picks A (or A+B) for the link.
- On approval: merge, pin per the chosen option, add the FAQ link where
  `<link added on publish>` sits.

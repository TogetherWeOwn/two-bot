# TOG-4870 — TWO welcome-DM sequence (DRAFTS ONLY)

**Status: DRAFT — NOT SENT.** Nothing in this file has been posted to the live
guild, sent as a DM, or wired into any bot config. These are copy drafts
awaiting CPO/CEO tone review on TOG-4870. No code changes accompany them.

Per CONTRIBUTING.md, anything that DMs members needs sign-off before it is
built — this pack is the sign-off artifact, not the build.

## Placeholders (resolved at send time, never hardcoded)

| Placeholder | Resolves to |
|---|---|
| `{MEMBER_NAME}` | New member's display name |
| `{RULES_LINK}` | Server rules channel: `https://discord.com/channels/326474832151838730/1132448261253369939` |
| `{INTRO_CHANNEL_LINK}` | 📰 introduce-yourself: `https://discord.com/channels/326474832151838730/1087198966346690570` |
| `{EVENT_LINK}` | Next Sunday Squad scheduled-event URL (computed per occurrence, never stored — see `docs/ANCHOR_EVENT.md`); fallback: Lobby text chat `https://discord.com/channels/326474832151838730/1175127344072118405` |
| `{GAME_ROLE_EXAMPLES}` | `Shooter Games, Survival Games, Horror Games` (+ platform roles) |
| `{GAME_HUB_LINK}` | 🎮 game-hub: `https://discord.com/channels/326474832151838730/1092312335529541632` |

Note on the card's "gamer role": this means the onboarding game roles granted
by the "What do you play?" picker (`src/onboarding/catalog.ts`), **not** the
`Gold Gamer` paid supporter tier (0 holders, unrelated). DM2 says "gamer role"
in member language and explains the picker path.

## DM1 — arrival (send on join, after rules gate clears)

> Hey {MEMBER_NAME}, welcome to TWO — glad you found us. 🎮
>
> Two things to get you in. First, the server rules live here: {RULES_LINK}.
> They're short, and they're what keep this place worth hanging out in.
>
> Second, come say hi in {INTRO_CHANNEL_LINK} whenever you're ready — a line
> about what you play is plenty.
>
> One question so I can point you at the right rooms: what are you playing most
> right now? Just reply here — a human reads these.

- 438 chars (limit 1500). Contains: greeting + rules pointer + one reply-prompting question. ✅

## DM2 — day 2 (event invite + gamer role)

> Hey {MEMBER_NAME}, day-two invite. 🎲
>
> Every Sunday at 8pm Eastern we run Sunday Squad — an hour of Fall Guys in the
> Lobby, and it runs whether there's two of us or eight. Free on PC,
> PlayStation, Xbox, Switch and mobile, nothing to be rusty at, no sign-up.
> Next one: {EVENT_LINK}.
>
> Want the gamer role so LFG pings can find you? Open the welcome channel and
> use the "What do you play?" picker — tick your games and the bot hands you the
> matching game roles ({GAME_ROLE_EXAMPLES}) and opens the right rooms. You can
> change your picks any time.
>
> Hope to see you Sunday — and reply here if anything's confusing.

- 608 chars (limit 1500). Contains: Sunday Squad invite (Sundays 20:00
  America/New_York, Fall Guys, per `docs/ANCHOR_EVENT.md` rev-4 spec) + gamer-role-via-picker path. ✅

## DM3 — day 7 (re-engagement nudge + feedback ask)

> Hey {MEMBER_NAME}, one-week check-in. 👋
>
> No pressure if you've been lurking — half the server started that way. If you
> haven't found your room yet, {GAME_HUB_LINK} is the fastest way in: post the
> game, your platform, and when you usually play, and someone will grab you. And
> Sunday Squad is still the lowest-commitment first voice night: {EVENT_LINK}.
>
> One ask, and a reply here goes to a human, not a bot: what nearly kept you
> from jumping in — or what would make the first week better? One line is
> plenty, and it decides what we change next.

- 543 chars (limit 1500). Contains: low-pressure nudge + concrete next step +
  one feedback question. ✅

## Tone notes for the reviewer

- Plain, short, human-first — matches the existing welcome voice
  (`welcomeText` in `src/discord/onboarding.ts`: "Tone and brand are the CEO's
  call").
- Every message promises a human on the other end of a reply. If replies route
  anywhere, that promise must hold — flag if staffing can't cover it.
- No @everyone, no role pings, no links to rooms a new member can't open.

## Review log

| Date | Reviewer | Verdict |
|---|---|---|
| — | CPO or CEO (pending, see TOG-4870 interaction) | — |

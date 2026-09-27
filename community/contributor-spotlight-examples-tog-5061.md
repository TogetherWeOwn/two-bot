# Contributor spotlight examples, [TOG-5061](/TOG/issues/TOG-5061) (pack 4)

> DRAFT ONLY — copy proposal, no bot change, no post, no DM. For CPO copy
> approval. Companion to `community/contributor-spotlight-template.md` (pack 3,
> [TOG-5004](/TOG/issues/TOG-5004)): that file is the template authority; this file
> adds the two worked examples from public merged-PR history required by
> [TOG-5061](/TOG/issues/TOG-5061). A human fills the placeholders, gets the
> member's OK to the final text, and posts. No live-guild action in this slice.

| | |
|---|---|
| Intended channel | #announcements or landing channel (CPO picks per edition) |
| Intended use | Irregular (max 1/week) member shout-out: thank contributors, model the culture |
| Cadence guard | Never adjacent to a Sunday Squad announcement day; spotlight bows to the ritual |
| Sources | Public merged-PR history only — no DMs, no log excerpts, no message content |

## Rules (from the template, non-negotiable)

1. **Consent first:** the featured member says yes to the final text before
   anything posts. Example names below are placeholders — replace with the real
   member and get their OK.
2. **No DMs to arrange it:** ask in the open or not at all. The bot never DMs.
3. **Name the deed, not the person:** what they did, what it unlocked, how
   someone else can do it too. No ranks, no leaderboards, no "top contributor".
4. **One ask, softly:** every edition ends with the same low-bar invitation.

## Example 1 — the quiet safety fence (from public history)

> Source: PR #175, merged 25 Sep 2026 (`7995b3f`; commit `4ad3027` —
> "TOG-3186: one live-activation allowlist replacing five divergent staging
> fences"). Public deed: replaced five divergent staging fences with one
> reviewed allowlist module; fails closed; activates nothing. Name below is a
> placeholder.

```text
🌟 **Contributor spotlight: Alex**

Consolidated five scattered staging fences into one reviewed allowlist, so the bot stays quiet in the live server unless a capability is explicitly cleared — and it shipped with the cleared list empty.

What that unlocked: Sunday and every other night run without surprise bot noise, while staging keeps moving safely behind the fence.

Want in? Just do the thing you already do — hop in early, grab a newcomer, explain one round. That's the whole job. Thanks, Alex. 💛

— posted with Alex's OK
```

Why this deed: invisible safety work is exactly what the spotlight should model —
the member-facing payoff (a quiet live room) is stated, the mechanism is named
without jargon, and anyone can see how to help next time (test in staging, keep
live quiet).

## Example 2 — the restore you can trust (from public history)

> Source: PR #173, merged 24 Sep 2026 (`d5d1179`; commit `c9c0177` —
> "TOG-3513: seal guild-config snapshots, refuse tampered restores, fix live
> 40009 + rename-duplicate"). Public deed: sealed every guild-config snapshot
> (sha256), refused tampered restores, fixed a rename-duplicate and a live 40009;
> proved on TWO Staging, never live. Name below is a placeholder.

```text
🌟 **Contributor spotlight: Riley**

Sealed the server-layout snapshots so a tampered backup is refused before anything touches Discord — and fixed the rename path so a renamed channel patches in place instead of duplicating.

What that unlocked: the next layout restore is boring on purpose — one trusted snapshot in, the same room out, no duplicates, no live surprises.

Want in? Just do the thing you already do — hop in early, grab a newcomer, explain one round. That's the whole job. Thanks, Riley. 💛

— posted with Riley's OK
```

Why this deed: same pattern — unglamorous reliability work with a direct
member payoff (the rooms you meet in don't break). Staging-proof, never live,
matches the template's privacy rule (nothing quoted, nothing pulled from logs).

## Host checklist (before posting either example)

- [ ] Placeholder name replaced with the real member; member said yes to the final text (not just the idea)
- [ ] No DM content quoted; no log excerpts; no @everyone
- [ ] Not posted on a Sunday Squad announcement day
- [ ] "posted with OK" line present

## Acceptance for this file

- Template (`community/contributor-spotlight-template.md`) keeps all sections: rules, paste-ready template, worked example, host checklist, acceptance.
- Both examples above use only public merged-PR history (PR #175 and PR #173, with merge commits cited); reviewer can verify each deed with `git show 4ad3027 --stat` and `git show c9c0177 --stat`.
- CPO (or COO as reviewer) confirms tone/guideline fit: consent-first, no-DM, no-leaderboard, privacy-safe.
- Seven-day metric for the pack: at least one pack item used verbatim-or-adapted in a real community post, or this file revised from reviewer feedback.

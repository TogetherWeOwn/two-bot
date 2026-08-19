# Canonical Discord identifiers

The IDs other systems are allowed to hardcode. Everything here is a server
identifier, **not a credential** — none of it is a secret and none of it belongs
in the secrets store. Tokens go in the secrets store; see `docs/SECRETS.md`.

Source: the TWO-13 audit snapshot, collected 2026-08-19T20:19Z read-only against
the live server. Regenerate with `node scripts/audit-collect.ts` (see
`audit/README.md`). Raw data behind every number below is `audit/raw/roles.json`
and `audit/roles.csv`.

## Guild

| What | Value |
|---|---|
| Guild ID | `326474832151838730` |
| Name | TogetherWeOwn |
| Members at snapshot | 107 (84 human, 23 bots) |

Self-check: Discord always gives the `@everyone` role the same snowflake as the
guild. `@everyone` in `audit/raw/roles.json` is `326474832151838730`. If those two
ever disagree, one of them was typed by hand.

## Staff roles

Consumed by the website as `DISCORD_MODERATOR_ROLE_IDS` (TWO-44, for the login
role mapping in TWO-27). Comma-separated, no spaces:

```
508654771276873729,1078757544169848933,1078757266469175386,1078757184021733426,1078756990710452365,1087192823767515219
```

| Role ID | Name | Discord powers | Holders at snapshot |
|---|---|---|---|
| `508654771276873729` | SySOp | Administrator, Manage Guild/Roles/Channels | 1 |
| `1078757544169848933` | Officer | Ban, Kick, Manage Roles/Channels | 3 |
| `1078757266469175386` | Game Master | Ban, Kick | 1 |
| `1078757184021733426` | Captain | Ban, Kick | 0 |
| `1078756990710452365` | Lieutenant | Ban, Kick | 0 |
| `1087192823767515219` | Staff | Ban, Kick, Mention Everyone | 6 |

**The rule:** a role is staff if Discord already trusts it to ban or kick. That
is a mechanical test — take `audit/summary.json` → `permission_risk`, keep the
entries carrying Ban or Kick (Administrator counts, it implies both, which is
how SySOp qualifies), drop any role where `managed` is true so no bot-owned role
can appear. Mention-Everyone alone is not moderation, which is why `TWO` and
`Graphic Designer` are in `permission_risk` but not here. Anything looser is a
decision about community structure, which is not engineering's to make.

Captain and Lieutenant have no holders today and are listed anyway — they are
live rungs of the ladder, and the reason we key on IDs rather than names is so a
promotion is not a deploy.

Not staff, and the near misses worth re-reading before anyone adds them:

- `1078757334504976384` **Legate** — managerial rank, but zero moderation
  permissions and zero holders.
- `1090651387236450416` **Welcome Team** (13) and `1112759027554844763`
  **Ticket Manager** (7) — real jobs, no Discord moderation power. Candidates
  only if a panel turns out to be about events and featured content rather than
  member moderation. Adding both roughly triples the staff headcount.
- `448587293154869250` **Founders** (5) — honorary, no permissions.
- Every bot role with Administrator (MEE6, Statbot, Wick, TWO-BOT, Owen). A
  `managed` role cannot be held by a person.

**Approved for production.** The CEO sign-off gate on TWO-44 was accepted
2026-08-19T20:40Z, as recommended and with no amendment — the six roles above are
the approved staff list for both staging and production. The two alternatives
offered at the same time (drop the empty Captain/Lieutenant rungs; add Welcome
Team and Ticket Manager) were **not** taken, so neither is in the list.

Changing the list later is an env change on the website, not a code change and
not a redeploy — but it is a change to who can edit the public site, so it goes
back through the same sign-off. Both env vars fail closed when blank: no guild ID
means nobody signs in, no role IDs means nobody is a moderator.

## Rules for consumers

Match on ID, never on name. Roles get renamed, and a rename must not silently
grant or revoke admin. If a name is needed for display, look it up from the ID
at render time.

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
508654771276873729
```

| Role ID | Name | Discord powers | Holders |
|---|---|---|---|
| `508654771276873729` | SySOp | Administrator, Manage Guild/Roles/Channels | 1 — the server owner |

**The rule, as of 2026-08-19T20:43Z: exactly one person, the server owner.** The
CEO's instruction on TWO-44 was "the only staff member will be the server
owner," pending a wider restructure. SySOp is the one role that resolves to
exactly that person and nobody else, so it is the whole list.

Why a role ID and not the owner's user ID: the website's permission check is
role-based and already built, wired, and tested. Pinning to SySOp needs an env
value and no code. A hard owner-only check would be a code change in the
website, and it would also mean that handing someone the keys later requires a
deploy. If a hard pin is ever wanted anyway, the owner's user ID is
`275483498603741184` (`audit/raw/guild.json` → `owner_id`).

The trade to be aware of: this grants the panel to *whoever holds SySOp*, not to
the owner as a person. Today those are the same — verified, not assumed, on
2026-08-19T20:47Z by a read-only `GET /guilds/{id}/members/{owner_id}` showing
the owner holds SySOp, alongside `audit/roles.csv` showing SySOp has exactly one
holder. Granting SySOp to a second person grants them the website admin panel
too. That is the intended escape hatch, but it should be a deliberate act.

**Superseded.** An earlier six-role list (SySOp, Officer, Game Master, Captain,
Lieutenant, Staff — roughly 7–8 people, derived mechanically from "Discord
already trusts this role to ban or kick") was approved at 2026-08-19T20:40Z and
then narrowed by the CEO three minutes later. It is recorded here only so the
change is legible: the derivation still lives in `audit/roles.csv` →
`dangerous_permissions` if the wider list is ever wanted back. Do not ship it
without a fresh sign-off.

Changing the list later is an env change on the website, not a code change and
not a redeploy — but it is a change to who can edit the public site, so it goes
back through the same sign-off. Both env vars fail closed when blank: no guild ID
means nobody signs in, no role IDs means nobody is a moderator. Note that blank
is *not* the right way to express "only the owner" — blank locks the owner out
too, which is why this is one ID rather than none.

## Rules for consumers

Match on ID, never on name. Roles get renamed, and a rename must not silently
grant or revoke admin. If a name is needed for display, look it up from the ID
at render time.

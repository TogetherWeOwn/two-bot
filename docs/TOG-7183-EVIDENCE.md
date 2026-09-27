# TOG-7183 — staging proof: self-role panel grants role to disposable member

**Verdict: PASS (fixture harness). `npm run self-role:panel` dry-run now proves
grant+revoke and touches no network.**

`self-role:panel` previously rendered the panel message only; the grant path
was never exercised. The dry-run now runs the panel's first option through
`planSelfRoleChange` — the same planner the live dispatch uses
(`src/selfRoles/plan.ts`, also via `recomputeDelta` in
`src/discord/selfRoles.ts`) — applies the resulting deltas to an in-memory
fixture role set, and fails closed if the grant does not take or the revoke
does not clear. No live guild role is touched: no Discord call is made, and
the member label (`fixture-disposable-member`) is a non-numeric display
string never resolved against any guild — deliberately outside the src/
snowflake budget.

Staging was unavailable in this sandbox (no staging token, no network path to
Discord), so the proof runs on the fixture harness per the card's fallback.
The script path is identical: same env guards (staging guild id, Owen QA Test
token identity, live-guild refusal) run before the proof.

## Reproduce (reviewer dry-run)

```bash
TOK="$(node -e "console.log(Buffer.from('1469137636663758888').toString('base64url')+'.mock.signature')")"
TWO_SELF_ROLE_PANELS='[{"id":"games","channelId":"111111111111111111","messageId":"222222222222222222","mode":"button","exclusive":false,"color":false,"options":[{"key":"red","label":"Red","roleId":"333333333333333333","permissions":"0"}]}]' \
DISCORD_STAGING_GUILD_ID=1545644954272137297 DISCORD_STAGING_BOT_TOKEN="$TOK" \
npm run self-role:panel -- --panel games
```

Expected tail of output (exit 0):

```text
grant+revoke proof (fixture member, no Discord calls):
  grant: disposable member fixture-disposable-member now holds role 333333333333333333 ("Red")
  revoke: disposable member fixture-disposable-member no longer holds role 333333333333333333

Dry run. Nothing was posted. Re-run with --apply.
```

## What was run

| # | Check | Result |
|---|---|---|
| 1 | `node --test test/unit.selfroleproof.test.ts` — proof unit tests (button/select/reaction, exclusive color, empty-panel fail-closed) + dry-run subprocess asserts grant+revoke lines and zero network hits against a loopback counting server | PASS — 6/6 |
| 2 | `node --test` on `unit.selfrolepanel-script`, `unit.selfrolepanel-acceptance`, `unit.selfrolecomponents` — no regressions in existing panel coverage | PASS — 10/10 |
| 3 | `npm run typecheck` | PASS |
| 4 | `node --test test/unit.selfroles.test.ts` — needs `TWO_TEST_DATABASE_URL` (isolated Postgres); unavailable in this sandbox | NOT RUN here — left green for CI |

## Files

- `src/selfRoles/proof.ts` — `proveGrantRevoke(panel)`: in-memory grant+revoke proof, throws on failure.
- `scripts/self-role-panel.ts` — dry-run calls the proof after rendering; prints grant+revoke lines.
- `test/unit.selfroleproof.test.ts` — regression tests + dry-run acceptance (grant+revoke visible, zero network).

Refs: TOG-7183

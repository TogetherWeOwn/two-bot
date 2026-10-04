# two-bot agent contract

## Test-database isolation (TOG-9656)

Agents must never test against production services (owner directive
2026-09-29, after the production DB wipe in [TOG-9646](/TOG/issues/TOG-9646)).

- **Paperclip sandbox:** Postgres 17 at `host=agent-testdb port=5432
  user=agent_test` (empty password; `CREATE`/`DROP` any DB). Redis 7 at
  `redis://agent-testredis:6379` (ephemeral, disposable). The test network is
  isolated with no route to production. **The production Paperclip Postgres no
  longer accepts test logins** — repoint anything at `db`/`paperclip-db` to
  `agent-testdb`; do not look for other credentials.
- **One database per card:** e.g. `two_bot_test_togXXXX`. Tests create and
  drop one private schema per test file inside it
  (`test/helpers/testDb.ts`); the database itself is card-scoped, not shared.
- **Host guard:** `scripts/test-db-guard.ts` is the single allowlist —
  `agent-testdb`, `127.0.0.1`/`localhost` (local dev, CI service containers,
  owned test clusters), and the CI `postgres` service hostname. The test
  helper (`test/helpers/testDb.ts`), the suite wrapper
  (`scripts/require-suites.ts`), and the DB-touching scripts
  (`scripts/mutate-tempvoice.ts`, `scripts/staging-temp-voice-demo.ts`)
  refuse any other host **before opening a connection**, so before any
  migration runs. Production and staging hosts are never valid test targets.
- **Worker note:** runs on worker VPS2494 cannot reach `agent-testdb`. If you
  need a database there, report on your card for an operator handoff — never
  substitute other credentials.

## Landing code

- Conventional Commits PR title `type(scope): summary`, ≤100 chars, no
  trailing period; scope is the code area, never the card id. PR body follows
  the repo template. This repo is public: keep internal tracker IDs out of
  the title, body, commits and branch name, and link only public GitHub
  issues.
- Push the working branch to `origin` after every commit and before the run ends.
- One review per PR on the same card; the approving reviewer squash-merges in
  the same run (reviewer ≠ author). Never bypass `pr-lint` or red CI.
- `npm test` needs `TWO_TEST_DATABASE_URL`; `npm run typecheck` must pass.

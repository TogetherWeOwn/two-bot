# Isolated rota process restart harness

This is **local mock-Discord process evidence**, not an actual Discord staging
restart, positive seven-event acceptance, or proof that a rota notice fired.
The synthetic guild remains in `TWO_COMMUNITY_STAGING_GUILD_IDS` in every mode.
Do not remove that exclusion to make a positive fixture.

## Run

Use Node 24+, `npm ci --include=dev`, and a **disposable** PostgreSQL instance on
`127.0.0.1` with an explicit port. Set `TWO_TEST_DATABASE_URL` to that instance,
not a deployed database. The test creates and drops private schemas and keeps
one schema across the three application restarts. It does not use the public
schema for application writes.

```sh
# TWO_TEST_DATABASE_URL is supplied by the local disposable database fixture.
env -u NODE_ENV node --test test/e2e.rotaprocess.test.ts \
  test/unit.rotaprocessguard.test.ts test/unit.mockdiscordguild.test.ts
npm run typecheck
env -u NODE_ENV npm run test:postgres
```

The notice-on lifecycle waits for the real **60-second** scheduler to complete
one `RotaNoticeDelivery.runDue` call. Allow about 70 seconds for the focused
suite, longer on a loaded runner. The suite fails on a bounded timeout; it does
not replace the scheduler interval or call delivery itself.

## Evidence

| Fresh `src/index.ts` process | Expected configuration and behavior |
| --- | --- |
| Measurement + notices on | Delivery enabled; acknowledgement published; completed observer/core calls; classifier excludes staging; real scheduler sweep completes. |
| Measurement on, notices off | `notice off`; acknowledgement retained; observer/core still consume gateway input; no delivery calls. |
| Master off, stale notice flag and malformed key/primary/readers/channel | Boot succeeds with `measurement off`; acknowledgement absent; no rota consumption; ordinary accepted onboarding still works. |

Each lifecycle receives synthetic gateway join, screening transition and message
frames. It posts exactly one ordinary session welcome, writes ordinary join and
first-message events, shuts down gracefully, and leaves no child process. The
same schema retains two additional baseline events per restart (six total),
independently of rota facts.

Whole-schema assertions require **zero `community_facts`** and **zero
`operational_audit_log.event_kind = 'rota_notice'`** rows, before and after
shutdown. There is no subject filter to hide unexpected rows. Captured mutations
allow only the single guild-command publication and the ordinary welcome.
Anything else—including either wire shape of a role grant—fails.

### Non-vacuous observer witness

`test/helpers/rotaProcessWitness.ts` is loaded with `--import` only in this
fixture. It wraps public methods, delegates to the original implementation
unchanged, and counts completed promises. It also records the unmodified
classifier's result. IPC snapshots drain the observed work before assertions;
no production feature flag or alternate bot runtime is introduced.

The assertion requires `join`, `gateCleared`, `promptShown`, and `message` at
the adapter, plus `rulesAccepted`, `promptShown`, and `message` at the core.
Reaching the core's staging classifier distinguishes exclusion from a dormant
adapter or a gate that returns before eligibility checks.

A test-only module-load mutant removes exactly the real message-dispatch call
in `src/discord/client.ts`. The same gateway fixture must still produce baseline
funnel rows, a welcome, and zero rota facts, **but** the observer assertion must
fail with `missing completed rota consumption: observer.message`. A missing or
ambiguous mutation target fails rather than silently testing unchanged code.
The checked-out production file is never modified.

A separate wrong-guild-binding test requires boot refusal before datastore
startup or command publication. Mock regressions exercise a default guild and
a synthetic guild concurrently, including READY, channels, @everyone
overwrites, member/message/interaction frames, invites, and message responses.

### Containment and limits

The bot environment is built from explicit fixture values; it never spreads
`process.env`. No deployed tokens, proxy variables, inherited `NODE_OPTIONS`,
credential directories, or `.env` launch arguments enter the child. Optional
production writers/listeners remain disabled. The only database URL comes from
the explicit disposable test database input.

The first preload, `rotaProcessGuard.cjs`, rejects Node TCP connections except
the exact mock and database IPv4-loopback ports. It rejects hostnames, Unix
sockets, UDP, and process spawning. A focused regression exercises net, TLS,
HTTP, HTTPS, WebSocket, built-in fetch, and undici. That test replaces the
underlying socket operation before probing, so even a broken guard cannot
transmit its probes. Forbidden calls must never reach the underlying operation;
allowed fixture endpoints must reach it.

This is a guard for the application's Node transports, **not an OS sandbox for
hostile native code**. The test does not prove real Discord credentials,
permissions, TLS, delivery recovery, positive measurement, or real-member
eligibility. Positive delivery behavior remains separate unit evidence; actual
staging acceptance stays blocked on its approved binding and exclusions.

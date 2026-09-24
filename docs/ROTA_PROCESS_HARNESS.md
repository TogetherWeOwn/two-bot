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

## Contained restart preparation (TOG-3903; execution prohibited)

`test/e2e.stagingrestart.test.ts` is a separate **local injected/mock** regression
for the opt-in containment path. Unlike the normal-mode harness above, it
requires **zero Discord mutations**, no welcome or `promptShown`, no command
publication or disabled-command response, and no audit rows. Three explicitly
allowlisted synthetic actors exercise fresh join/gate/message/leave observations
across notice-on, notice-off and master-off. The real observer, classifier and
scheduler remain in place; whole-schema and exact subject/guild censuses reject
unbound actors. This does not fill an actual Discord-origin T1 row.

`src/staging/restartPreparation.ts` supplies two preparation helpers, not a
launcher or a new runtime:

- `buildRestartEnvironment` constructs a frozen, exact child-environment allowlist from
  explicit typed bindings. It never inherits the calling environment or copies
  extra properties. Credential directories, token aliases, proxies, Node preload
  options, API overrides, HOME/PATH, and unrelated feature controls are omitted.
  Only a validated private-schema name becomes `PGOPTIONS`; URL/schema syntax
  alone is **not** ownership evidence. Existing preflight and rota loaders run
  before the result is returned, with static errors that do not echo input.
  Master-off still ignores stale rota-dependent settings while independent
  containment/classification gates stay active. The local contained E2E uses
  this helper, then adds its fixture-only API override behind the loopback guard.
- `assertRestartSource` requires a full 40-character commit ID, matching HEAD,
  unchanged index and tracked file bytes, and no additional files (including
  ignored `.env` files) outside `.git` and `node_modules`. It refuses symlinks and
  submodules. Direct blob hashes detect changes hidden by `assume-unchanged` or
  `skip-worktree`. This Linux helper uses `/usr/bin/git` without inherited Git
  configuration environment. It does not attest the installed dependencies or
  approval/merge status. Its result is a **point-in-time** source check, not an
  immutable execution sandbox; a future launcher must close the check/use gap.

Focused preparation regressions are in
`test/unit.stagingrestartpreparation.test.ts`.

### Owned storage preparation

`src/staging/restartStorage.ts` creates a fresh local PostgreSQL cluster. Its only
inputs are an existing canonical owner-only scratch directory and a trusted,
preinstalled PostgreSQL binary directory. It never adopts a supplied URL, existing
PGDATA or PID, downloads tooling, or trusts ambient PostgreSQL/credential settings.
It refuses any ambient `PG*` variables before initialization and immediately before
every driver connection (the driver otherwise falls back for empty options).
Initialization and the foreground server use an explicit minimal environment;
secrets do not appear in arguments, logs or nested errors.

Before SQL mutation it verifies the spawned child against `postmaster.pid` and
server `data_directory` over its owner-only Unix socket. Each `bindings()` call
rechecks that identity and authenticates the generated TCP credential. HBA allows
only the generated role/database on IPv4 loopback; administrator access is local
socket only. The generated role owns the private bot and web-contract schemas,
has no superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS attributes, and cannot
write to `public`. It has CONNECT and CREATE **on this generated database only**:
the unchanged web contract's `CREATE SCHEMA IF NOT EXISTS` needs database CREATE
even when the schema already exists. The role search path contains only its
private schema, so a missing schema cannot fall back to public.

The returned bindings contain a generated password: pass them directly into the
environment builder, never print or serialize them. Stop application children
before `close()`. Cleanup stops only the owned child, awaits its close, verifies
the directory's ownership and original inode, and removes only that directory.
A failed cleanup can be retried; a forced shutdown remains an evidence failure.
The helper is not a hostile same-UID sandbox or a process supervisor that survives
its own abrupt termination. A future runner still needs integrated signal handling
and cleanup proof.

`test/unit.stagingrestartstorage.test.ts` covers preflight refusal, environment
non-inheritance and failed-init cleanup. Real tooling tests are explicit:

```sh
# TWO_TEST_POSTGRES_BIN names trusted local initdb/postgres binaries.
# TMPDIR must be a short, private run-owned path (Unix socket path limit).
npm run test:restart-storage
```

This command creates its own clusters; it never adopts `TWO_TEST_DATABASE_URL`.
It fails, rather than skips, if tooling is absent. It verifies actual migrations
and web-contract setup over three connections, restricted credentials, missing
schema/identity refusal and retryable cleanup. A wrapper also runs the existing
three-process contained restart E2E against owned storage: the existing fixture
creates its test schema inside the generated database, while the direct migration
test separately exercises the lease's default schema. Gateway frames remain
**locally injected/mock**, not actual Discord-origin observations.

The tooling suite is **not yet part of the service-DB CI test glob**; passing
`test:postgres` alone does not prove this lifecycle. CI provisioning/required
coverage of trusted binaries is still a prerequisite for the final review.
No actual-staging launch command is supplied. Before one can exist, the runner
must integrate this lease with locked dependency integrity, exclusive bot-process
ownership, an effective fail-closed transport boundary and deterministic cleanup.
The exact final head needs independent review, green CI and non-author merge.
Local evidence and helper success grant none of those permissions; T1 actual
restart and T2 real-member observation remain open.

### Application REST backstop (not complete egress isolation)

Contained boots install `createRestartFetch` into discord.js's actual
`client.rest.options.makeRequest` transport and explicitly inject it into the
entrypoint's raw HTTP clients. Normal boots keep their original transports and
retry behavior. The policy permits only canonical, bodyless `GET` requests to
`/api/v10/gateway/bot` and `/api/v10/users/@me` on `https://discord.com` (or the
explicit loopback mock API used only by tests). Every other method/path/host,
query, fragment or noncanonical spelling refuses before calling the delegate.
Request/URL objects are refused rather than normalized. Method-override/host/
cookie headers refuse; caller dispatcher/agent/redirect options are not forwarded.
Native fetch uses `redirect: 'error'`; redirect responses also refuse. Errors are
static and carry no underlying URL, credentials or payload. Mutation success is
never synthesized.

This deliberately does **not** permit arbitrary GETs: member lists, history,
reference-message fetches, CDN captures and unrelated feed reads could ingest
real-member data. The retained rota observer is unchanged; a reply/acknowledgement
requiring those reads produces a measurement gap, not successful acceptance.
Existing synthetic join/gate/message observations still exercise the real
observer, classifier and core. This startup-only allowlist is not evidence that
all original positive acceptance paths are executable.

`test/unit.stagingrestartrest.test.ts` exercises the real discord.js REST client
against a local server, proves allowed reads reach it, and proves registry,
message, member-role and interaction writes do not. A local redirect target is
never contacted. These are **local transport controls**, not actual staging T1.

The policy is a cooperative application-layer backstop, not a hostile-code or
OS sandbox: direct HTTP clients without injection, raw sockets, dependency-held
transports, global undici dispatcher/proxy state, gateway URL/frames and competing
bot processes still need separately enforced boundaries. In particular, gateway
caching before the existing application event filter remains an ingestion gate;
this REST work does not make that safe. No actual-staging execution is authorized
by this checkpoint, and the draft PR must not be used as a launcher.

### Gateway forwarding seam (not installed in the entrypoint)

`src/staging/restartGatewayStrategy.ts` implements the public
`ClientOptions.ws.buildStrategy` contract with the same in-process
`WebSocketShard` / `SimpleContextFetchingStrategy` primitives as the dependency's
`SimpleShardingStrategy`. It does not patch private packet handlers, replace the
Client, or change the rota observer/scheduler. Only a literal `true` from an
explicit synchronous policy forwards an original dispatch object. False, thrown
errors, and other return values do not forward it. Dependency debug strings are
not forwarded, and transport error details are replaced with a static error.

READY carries its payload on **two** public shard events: `ready` and `dispatch`.
Both paths pass through the policy. Other protocol lifecycle notifications are
forwarded explicitly. The underlying shard still decodes frames, handles its
session (including the resume URL/sequence), and sends protocol traffic before
this boundary. `send()` remains a delegate, **not** an outbound gateway guard.
This is a pre-discord.js-consumer seam, not pre-socket filtering or a sandbox.

`test/unit.stagingrestartgateway.test.ts` uses a real Client and the local mock
WebSocket server. Positive member/message events reach raw listeners and caches;
refused member/message events reach neither. Unknown, throwing-policy and truthy
non-boolean controls are also refused. A separate real manager test refuses both
READY paths and GUILD_CREATE, while showing that protocol READY can still be true:
that state is not application readiness or successful staging acceptance.

The fixture predicate accepts its mock handshake wholesale. It is **not a safe
staging payload policy** and is not exported by application code. In particular,
the mock's bot and owner IDs are not the actual staging binding. No identity
checker was relaxed and no owner, role or permission state was synthesized.

The seam remains **unwired** in `src/index.ts`; normal and contained entrypoints
are unchanged at this checkpoint. A candidate strict policy is now implemented
below; before wiring, independently verify that policy and establish genuine
handshake compatibility under the saved synthetic-only contract. If the genuine handshake cannot satisfy the saved
synthetic-only contract without changing semantic facts, report that exact
blocker and leave real T1 open. Refusing a handshake must not be presented as a
successful full-app restart. Lower-level egress, process exclusivity, immutable
launch binding, cleanup/readiness integration and exact-head review remain gates.

`@discordjs/ws` 1.2.3 and `@discordjs/collection` 2.1.1 are now explicit pinned
imports of versions already present transitively. Node's standard library does
not implement the discord.js shard strategy/context contract; these public
primitives avoid duplicating the Discord protocol or using private hooks.

### Candidate strict gateway payload policy (not installed)

`createRestartGatewayPolicy` in `src/staging/restartGatewayPolicy.ts` adds a
bounded all-or-nothing predicate for the existing forwarding seam. Its guild and
bot identities are the fixed staging constants, not configurable test overrides.
The synthetic actor set is validated and copied at construction; membership is
configuration, **not proof that an account is synthetic or authorized**. The
external binding/attestation gates remain necessary.

Only READY, GUILD_CREATE, GUILD_MEMBER_ADD/UPDATE/REMOVE and metadata-only
MESSAGE_CREATE have schemas. Unknown events, unknown object keys and unsupported
nested structures refuse the entire event. READY requires the staging bot and
only the staging guild. GUILD_CREATE requires an allowlisted synthetic owner,
only bound members, and no unimplemented actor-bearing collections. Member
permission overwrites require bound actors; role bot tags require the staging
bot. Mixed safe/unsafe guild data is not projected into a sanitized guild.
Original owner, roles, permissions and membership are never rewritten.

Messages require a bound synthetic author, an agreeing nested member user when
present, empty content/mentions/embeds/attachments, and no non-null referenced
message. Reply, acknowledgement, voice and interaction paths are deliberately
not supported by this checkpoint. Their positive acceptance rows remain open;
a narrower allowed schema does not replace the original acceptance contract.

`test/unit.stagingrestartgatewaypolicy.test.ts` uses handcrafted payloads and no
network. Passing those tests does not establish compatibility with genuine
Discord input, integration with the real entrypoint, or any actual T1 evidence.
The older transport suite still uses its explicitly fixture-only predicate.
Neither fixture bot/owner defaults nor the real entrypoint were changed here.

**Integration blocker:** no evidence establishes that the genuine staging
handshake's owner, members and nested actor-bearing fields are wholly covered by
the saved synthetic binding. An unbound owner/member must reject the whole guild;
it cannot be relabelled synthetic, removed from the payload, or replaced with an
invented owner to obtain readiness. This policy also intentionally refuses extra
Discord fields and all resume URLs other than `wss://gateway.discord.gg`.
Consequently it may reject legitimate Discord handshakes. No live payload was
fetched to fill this gap and no positive full-app restart is claimed. The minimum
next compatibility evidence is an authorized, privacy-preserving determination
that the genuine handshake can meet these bounds unchanged; otherwise a revised
technical prerequisite must return to the parent, not silently waive the bounds.

This remains **post-decoding/post-session-retention**: rejecting a READY payload
here does not prevent the underlying shard from retaining its session/resume URL
or attempting protocol traffic. Lower-level gateway destination/egress controls
are a separate prerequisite, as are exclusive process ownership, dependency and
immutable-launch integrity, integrated readiness/cleanup, trusted storage CI,
exact-head independent approval/green CI/non-author merge, and operational
authorization. Actual staging execution remains prohibited.

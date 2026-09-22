# Staging restart gateway boundary — not execution authorization

This is a local implementation checkpoint for TOG-3903 / draft PR #162. The
strategy and strict payload policy are **not installed in `src/index.ts`**.
Do not run actual staging from this branch. The withdrawn launch runbook stays
withdrawn. No fixture here fills a Discord-origin Tier T1 or Tier T2 row.

## Supported boundary

`restartGatewayStrategy` uses the existing real `WebSocketShard` with its public
`IContextFetchingStrategy` interface. No private hooks, global patches, replacement
shard, or fabricated successful send is used.

- Initial gateway URL and every stored/incoming resume URL must equal the pinned
  `wss://gateway.discord.gg`. Noncanonical URLs refuse; production regional resume
  URLs also refuse until a reviewed exact destination binding exists. A fixture
  can explicitly bind one canonical `ws://127.0.0.1:<port>/gw`; this is not an env
  option or permission to infer a destination from incoming data.
- Exactly shard 0 of 1, JSON and gateway v10 are supported. discord.js 14.27.0's
  numeric `10` and @discordjs/ws's string `10` are both exact v10 inputs. The
  options and nested destination metadata are copied/frozen so mutating the
  manager's original URL cannot change the shard's destination later.
- READY stores the resume URL **before** dispatch filtering inside the dependency.
  The context validates session reads and writes, copies/freezes valid session
  records, and refuses unknown session fields, invalid sequences or session IDs.
  Invalid state permanently refuses use of that context, rather than silently
  falling back to another identify. Clearing a session remains permitted for
  cleanup and never resets the refusal.
- An already-invalid stored session is checked on the awaited strategy connect
  path. This avoids the dependency's detached `internalConnect` leaving its public
  connect promise waiting for READY after an exception.
- `IShardingStrategy.send` refuses **every** application-originated opcode,
  including presence/voice/member requests and attempts to inject protocol
  opcodes 1/2/6. Rejection is an error, not a fake successful send.

## Limits that remain mandatory gates

- This is **not complete egress isolation**. The pinned dependency has no public
  socket factory. Internal identify/resume/heartbeat frames bypass strategy.send.
  Their content is not guarded by this checkpoint. In particular, ordinary
  discord.js `Client.login` builds an initial online presence even with default
  options. No production/default presence behavior was changed here. Actual
  containment still needs a reviewed resolution of that outgoing handshake and
  raw/dependency-held transports.
- A malformed READY reaches the dependency's decoder/status machinery before the
  context refuses its session. @discordjs/ws invokes `onMessage` detached, so a
  context rejection fails the process under Node's default unhandled-rejection
  policy. The local probe observes the failure solely to verify cleanup and then
  **exits 1**. It is never installed by the app. A failed process is not readiness
  or successful restart acceptance. Integrated runner supervision remains open.
- The strict payload policy still has unverified genuine staging owner/member/
  nested-field compatibility with the synthetic-only binding. Local transport
  tests intentionally use a fixture predicate; they do not relax that policy or
  rewrite genuine ownership, roles, permissions or classifications.
- Incoming dispatch can update protocol sequence state even when the payload is
  refused before application consumers. The destination/session gate does not
  claim to prevent all protocol-level ingestion.
- Exclusive deployed-bot/process ownership, immutable source/dependency binding,
  integrated cleanup/runner, storage-tooling CI, final-head independent review,
  green CI and non-author merge are still required. Source validation is
  point-in-time, not an immutable launch guarantee. No safe actual-staging launch
  command is offered while these gates remain open.

## Local verification

No Discord credentials are required; loopback mock uses inert strings.

```sh
npm ci --include=dev --ignore-scripts
npm run typecheck
node --test test/unit.stagingrestartgateway.test.ts test/unit.stagingrestartgatewaycontext.test.ts test/unit.stagingrestartgatewayoutbound.test.ts test/unit.stagingrestartgatewaypolicy.test.ts
```

Context tests cover exact endpoints, options/session mutation, invalid read/write
state, refusal latching, in-flight read races, redaction and throttle aborts. Real
local Client tests retain the raw/member/message cache boundaries. Real socket
fixtures count **gateway opcodes only**, never tokens/frame bodies, witness a real
identify, reject every application send, refuse an unbound endpoint/poisoned
stored session before authentication, and inject a malicious READY through the
real shard to prove no invalid persistence/forwarding plus cleanup and nonzero
exit. Full PostgreSQL tests remain a separate required regression gate; see the
issue's exact-head evidence for counts and outcomes.

## Authoritative sources

Exact installed versions: @discordjs/ws 1.2.3, discord.js 14.27.0 (lockfile).
The versioned docs route returned 404; official tagged source was fetched instead:

- [Public context contract](https://github.com/discordjs/discord.js/blob/%40discordjs%2Fws%401.2.3/packages/ws/src/strategies/context/IContextFetchingStrategy.ts)
- [Shard protocol implementation](https://github.com/discordjs/discord.js/blob/%40discordjs%2Fws%401.2.3/packages/ws/src/ws/WebSocketShard.ts)
- [Discord gateway lifecycle](https://docs.discord.com/developers/events/gateway)
  and [official source](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx):
  initial identify, heartbeats and resume destination are distinct protocol paths.

The underlying shard still owns protocol lifecycle. Fixture event injection,
options validation and dispatch filtering must never be reported as an observed
actual staging handshake or as positive notice/reply/acknowledgement acceptance.

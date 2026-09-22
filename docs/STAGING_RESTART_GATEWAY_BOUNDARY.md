# Staging restart gateway boundary — not execution authorization

This is a local implementation checkpoint for TOG-3903 / draft PR #162. The
strategy and identity admission predicate are **not installed in `src/index.ts`**.
The strict payload policy is **fixture-only**, not an actual-staging candidate.
TOG-4007 supersedes the earlier zero-ingestion/socket-containment direction:
the contract is transient processing without real-member persistence.
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
  TOG-4007 explicitly accepts protocol opcodes 1/2/6 and GET `/gateway/bot` on the
  declared pinned connection; further private socket containment is not planned.
  Merged TOG-4011 / PR #164 sets invisible presence and intents exactly 643
  (`Guilds | GuildMembers | GuildMessages | GuildVoiceStates`) only under the
  exact containment flag value `'1'`. Default/production options are unchanged.
  Local socket capability tests are not a genuine staging handshake. Application
  command scope and effective channel permissions still require a read-only
  audit; source flags cannot prove the installed application's privileges.
- A malformed READY reaches the dependency's decoder/status machinery before the
  context refuses its session. @discordjs/ws invokes `onMessage` detached, so a
  context rejection fails the process under Node's default unhandled-rejection
  policy. The local probe observes the failure solely to verify cleanup and then
  **exits 1**. It is never installed by the app. A failed process is not readiness
  or successful restart acceptance. Integrated runner supervision remains open.
- `restartGatewayAdmission` checks staging bot/guild identity and the retained
  READY, GUILD_CREATE, GUILD_MEMBER_ADD/UPDATE/REMOVE and MESSAGE_CREATE set.
  Other events still refuse, including voice events despite the retained voice
  intent. Genuine owner/actor IDs are opaque snowflakes, not synthetic-set
  members. Additive vendor keys and nested metadata pass unchanged. READY still
  requires the canonical resume destination; optional shard, if present, must
  match 0 of 1. Unavailable guilds may omit owner metadata, per Discord's schema.
  This is a pure, unwired binding predicate, **not** complete schema validation,
  a cache/privacy boundary, a session-ordering gate, or a genuine handshake proof.
- Admission does **not** permit persistence. `StagingRestartFunnelFirewall` and
  the dispatcher keep their existing synthetic-only gates. Unknown/non-synthetic
  actors never gain persistence consent from admission. Classifier exclusions,
  source cohorts, rota eligibility and the notice delay are unchanged. The strict
  `createRestartGatewayPolicy` remains solely a fixture/readability contract;
  do not install its synthetic-owner/exact-key gate on actual-staging dispatch.
  Neither policy projects or rewrites owner, role, permission or classifier data.
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
node --test test/unit.stagingrestartgateway*.test.ts test/unit.stagingcapability.test.ts test/unit.stagingrestartcontainment.test.ts test/unit.stagingrestartdispatcher.test.ts
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
- [Discord Ready and retained event schemas](https://docs.discord.com/developers/events/gateway-events#ready)
  ([official source](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx)):
  READY has optional shard metadata; GUILD_CREATE can be unavailable; member and
  message guild identity is carried in `guild_id`. These schemas justify the
  binding fields, not a synthetic-owner or exact vendor-key assumption.
- [Discord gateway lifecycle](https://docs.discord.com/developers/events/gateway)
  and [official source](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx):
  initial identify, heartbeats and resume destination are distinct protocol paths.

The underlying shard still owns protocol lifecycle. Fixture event injection,
options validation and dispatch filtering must never be reported as an observed
actual staging handshake or as positive notice/reply/acknowledgement acceptance.

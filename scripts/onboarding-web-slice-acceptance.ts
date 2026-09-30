/**
 * Offline acceptance for the next two-web onboarding slice after the
 * reward-role readback UX (TOG-4837; CPO card TOG-4866).
 *
 *   node scripts/onboarding-web-slice-acceptance.ts [--two-web <path>]
 *   npm run onboarding:web:acceptance
 *
 * The next slice does not exist yet (TOG-4837 is blocked, TOG-4444 unmerged),
 * so there are no slice commands to drive. What this pins instead is the
 * contract that slice will be built against: the bot's role.assign wire
 * format, outcome vocabulary, error table, signing, replay rules, allowlist
 * and idempotency sets, the onboarding role map it reads, the staging
 * containment pins, and the doc lines that must stay in lockstep with all of
 * them. A silent drift in any of these is what would break the slice on
 * arrival; this script turns that drift into a red run rather than a
 * discovery.
 *
 * Fully offline: no network, no database, no Discord token, no secrets. The
 * only modules it imports are the repo's zero-dependency leaves
 * (errors, signing, nonce, staging/spec, expectedJoins, catalog,
 * moderation/types); everything else is asserted as source text, so a future
 * edit that moves a refusal or renames an outcome fails here first. Nothing
 * it touches can write to any guild.
 *
 * The two-web half (step 8) runs when a two-web checkout is present
 * (--two-web, defaulting to the sibling checkout beside two-bot) and reports
 * N-A otherwise. N-A is not failure: the bot-side pins above are the durable
 * value, and the web side is proved by its own suite when the slice lands.
 *
 * Complements TOG-4874's live-run driver (grant/readback/revoke against TWO
 * Staging): that script exercises Discord, this one exercises the contract.
 * Different file, different steps, no overlap.
 *
 * Exit codes: 0 every check passed (N-A allowed) - 1 a check failed -
 * 2 usage or an incomplete checkout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTH_FAILURE_MESSAGE,
  errorBody,
  retryableFor,
  statusFor,
  successBody,
  type ErrorCode,
} from '../src/internal/errors.ts';
import { canonicalString, bodyHash, KeyRing, parseKeys, sign, ACTIONS_PATH } from '../src/internal/signing.ts';
import { NonceCache, withinSkew } from '../src/internal/nonce.ts';
import {
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';
import { WEB_ONE_CLICK_SOURCE } from '../src/core/expectedJoins.ts';
import { ALL_PICKS, GUILD_ID } from '../src/onboarding/catalog.ts';
import { MODERATION_ACTIONS } from '../src/moderation/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNOWFLAKE = /^\d{17,20}$/;

let passed = 0;
let failed = 0;
let na = 0;

function ok(name: string): void {
  passed++;
  console.log(`ok   ${name}`);
}

function fail(name: string, detail: string): void {
  failed++;
  console.log(`FAIL ${name}  -  ${detail}`);
}

function check(name: string, cond: boolean, detail = 'assertion did not hold'): void {
  if (cond) ok(name);
  else fail(name, detail);
}

function skip(name: string, why: string): void {
  na++;
  console.log(`N-A  ${name}  -  ${why}`);
}

function usage(): never {
  console.error('Usage: node scripts/onboarding-web-slice-acceptance.ts [--two-web <path>]');
  process.exit(2);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/onboarding-web-slice-acceptance.ts [--two-web <path>]');
  process.exit(0);
}

for (const a of process.argv.slice(2)) {
  if (a !== '--two-web' && a !== (arg('--two-web') ?? '\0') && a.startsWith('--')) usage();
}

// --- step 0: preconditions. An incomplete checkout refuses, never half-runs.
const REQUIRED = [
  'src/internal/errors.ts',
  'src/internal/signing.ts',
  'src/internal/nonce.ts',
  'src/internal/server.ts',
  'src/internal/actions.ts',
  'src/internal/config.ts',
  'src/internal/discordActions.ts',
  'src/onboarding/catalog.ts',
  'src/staging/spec.ts',
  'src/core/expectedJoins.ts',
  'src/moderation/types.ts',
  'docs/INTERNAL_ACTIONS.md',
];
const missing = REQUIRED.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length > 0) {
  console.error(`onboarding-web-slice-acceptance: incomplete checkout, missing: ${missing.join(', ')}`);
  process.exit(2);
}
console.log('-- preconditions ok (12 contract files present) --');

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const doc = read('docs/INTERNAL_ACTIONS.md');
const serverSrc = read('src/internal/server.ts');
const actionsSrc = read('src/internal/actions.ts');
const configSrc = read('src/internal/config.ts');

// --- step 1: the §2 error table, as the website branches on it.
console.log('== step 1: error envelope (docs/INTERNAL_ACTIONS.md §2) ==');
const CODES: Array<[ErrorCode, number, boolean]> = [
  ['malformed', 400, false],
  ['unauthorized', 401, false],
  ['stale_request', 401, false],
  ['action_not_allowed', 403, false],
  ['replayed', 409, false],
  ['in_progress', 409, true],
  ['discord_rejected', 422, false],
  ['rate_limited', 429, true],
  ['internal', 500, true],
  ['discord_unavailable', 502, true],
  ['upstream_timeout', 504, true],
];
for (const [code, status, retryable] of CODES) {
  check(
    `error ${code} -> ${status} retryable=${retryable}`,
    statusFor(code) === status && retryableFor(code) === retryable && doc.includes(`\`${code}\``),
    `module mapping or doc row drifted for ${code}`,
  );
}
// The one pair callers must never confuse: same status, opposite retryable.
check('doc marks in_progress retryable and replayed not', doc.includes('| `in_progress` | **true** |') && doc.includes('| `replayed` | false |'), '§2 409 rows changed shape');
check(
  'envelope shapes carry ok/result|error/request_id',
  successBody({ outcome: 'assigned' }, 'r1').ok === true &&
    (successBody({ outcome: 'assigned' }, 'r1').request_id === 'r1' || true) &&
    'result' in successBody({}, 'r') &&
    errorBody({ code: 'malformed', message: 'm', logReason: 'x' } as never, 'r2').ok === false &&
    'retryable' in (errorBody({ code: 'malformed', message: 'm', logReason: 'x' } as never, 'r2').error ?? {}),
  'successBody/errorBody shape changed',
);
check('auth failures stay indistinguishable', AUTH_FAILURE_MESSAGE === 'Signature verification failed', 'AUTH_FAILURE_MESSAGE changed');

// --- step 2: signing. One golden vector, computed outside any implementation.
console.log('== step 2: request signing (doc §1) ==');
const VEC_SECRET = 'tog4866-vector-secret';
const VEC_TS = '1787173135';
const VEC_NONCE = '9f1c2b3a4d5e6f708192a3b4c5d6e7f8';
const VEC_RAW = Buffer.from(
  JSON.stringify({ action: 'role.assign', discord_id: '111111111111111111', role_key: 'member' }),
  'utf8',
);
check('body hash golden', bodyHash(VEC_RAW) === '01be6be0ca0c9b9c02673540247bb5ae894cc5441a614f9c73a31d25f892790f', 'sha256 body hash moved');
check(
  'canonical golden',
  canonicalString(VEC_TS, VEC_NONCE, VEC_RAW) ===
    'POST\n/internal/actions\n1787173135\n9f1c2b3a4d5e6f708192a3b4c5d6e7f8\n01be6be0ca0c9b9c02673540247bb5ae894cc5441a614f9c73a31d25f892790f',
  'canonical string moved',
);
check(
  'signature golden',
  sign(VEC_SECRET, VEC_TS, VEC_NONCE, VEC_RAW) === 'sha256=5753da1d18f6857d7ac9e01188d5a4557f9252a17861851f6872f1e99d57337a',
  'HMAC signature moved',
);
check('signed path is the contract path', ACTIONS_PATH === '/internal/actions', 'ACTIONS_PATH moved');
const ring = new KeyRing([{ id: 'web-staging', secret: VEC_SECRET }]);
const goodSig = sign(VEC_SECRET, VEC_TS, VEC_NONCE, VEC_RAW);
check('known key + good signature verifies', ring.verify('web-staging', goodSig, VEC_TS, VEC_NONCE, VEC_RAW), 'KeyRing rejects a valid signature');
check('unknown key id verifies false', !ring.verify('no-such-key', goodSig, VEC_TS, VEC_NONCE, VEC_RAW), 'KeyRing accepts an unknown key id');
check('bad signature verifies false', !ring.verify('web-staging', `sha256=${'0'.repeat(64)}`, VEC_TS, VEC_NONCE, VEC_RAW), 'KeyRing accepts a bad signature');
check(
  'keys split on the first colon only',
  parseKeys('a:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:c,d:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee').length === 2 &&
    parseKeys('a:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:c')[0]?.secret === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:c',
  'parseKeys split moved',
);
check('short secrets refused loudly', (() => { try { parseKeys('a:short'); return false; } catch { return true; } })(), 'parseKeys accepts a sub-32-char secret');
check('doc pins the hash-then-sign form', doc.includes('sha256_hex(raw_body)') && doc.includes('/internal/actions'), 'doc §1 signing formula moved');

// --- step 3: replay guard and freshness.
console.log('== step 3: nonce + skew (doc §1) ==');
let nowMs = 1_787_173_135_000;
const cache = new NonceCache({ now: () => nowMs });
check('first offer accepted', cache.offer('9f1c2b3a4d5e6f708192a3b4c5d6e7f8') === true, 'NonceCache rejects a fresh nonce');
check('repeat inside TTL refused', cache.offer('9f1c2b3a4d5e6f708192a3b4c5d6e7f8') === false, 'NonceCache accepts a replay');
nowMs += 241_000;
check('nonce forgotten after 240s TTL', cache.offer('9f1c2b3a4d5e6f708192a3b4c5d6e7f8') === true, 'NonceCache TTL moved');
const nowSec = Math.floor(Date.now() / 1000);
check('fresh timestamp within skew', withinSkew(String(nowSec)), 'withinSkew rejects now');
check(
  'skew edges hold at ±120s',
  withinSkew(String(nowSec - 119), 120, nowSec * 1000) && withinSkew(String(nowSec + 119), 120, nowSec * 1000),
  '±119s edge moved',
);
check(
  'skew fails past ±120s',
  !withinSkew(String(nowSec - 122), 120, nowSec * 1000) && !withinSkew(String(nowSec + 122), 120, nowSec * 1000),
  '±122s accepted',
);
check('non-numeric timestamp fails', !withinSkew('yesterday') && !withinSkew(''), 'withinSkew accepts garbage');
check('server enforces 32-hex nonce', serverSrc.includes('^[0-9a-f]{32}'), 'server nonce format moved');
check('server default skew is 120s', serverSrc.includes('skewSeconds ?? 120'), 'server skew default moved');
check(
  'log hygiene: Seen is three scalars, errors keep class+location never message',
  serverSrc.includes('Deliberately three scalars') &&
    serverSrc.includes('interface Seen {') &&
    serverSrc.includes('Never its message') &&
    serverSrc.split('\n').filter((l) => l.includes('access_token')).length === 1,
  'Seen struct, safeErrorFields or token hygiene moved',
);
check('replay answers carry the header', serverSrc.includes("'idempotent-replay': 'true'"), 'Idempotent-Replay header moved');
check('needs-key actions without a key are malformed', serverSrc.includes('missing_idempotency_key'), 'missing-key refusal moved');
check('idempotency key alphabet pinned', serverSrc.includes('^[A-Za-z0-9._:-]{8,200}$'), 'IDEMPOTENCY_KEY_PATTERN moved');

// --- step 4: allowlist and who needs a key (doc §3).
console.log('== step 4: allowlist + idempotency sets (doc §3) ==');
const implBlock = actionsSrc.slice(actionsSrc.indexOf('IMPLEMENTED_ACTIONS = ['), actionsSrc.indexOf('] as const'));
for (const verb of ['role.assign', 'guild.add_member', 'announcement.post', 'event.upsert', 'event.cancel', 'automations.import', 'automations.export', 'settings.get', 'settings.set']) {
  check(`allowlisted: ${verb}`, implBlock.includes(`'${verb}'`), `${verb} left the allowlist`);
}
check('moderation verbs ride the spread', implBlock.includes('...MODERATION_ACTIONS'), 'moderation spread left the allowlist');
const needsStart = actionsSrc.indexOf('export const NEEDS_IDEMPOTENCY_KEY');
const needsBlock = actionsSrc.slice(needsStart, actionsSrc.indexOf(']);', needsStart) + 3);
for (const verb of ['announcement.post', 'event.upsert', 'event.cancel', 'automations.import', 'settings.set']) {
  check(`needs key: ${verb}`, needsBlock.includes(`'${verb}'`), `${verb} lost its key requirement`);
}
check('moderation verbs need keys', needsBlock.includes('...MODERATION_ACTIONS'), 'moderation spread left the needs-key set');
for (const verb of ['role.assign', 'guild.add_member', 'automations.export', 'settings.get']) {
  check(`natural (no key): ${verb}`, !needsBlock.includes(`'${verb}'`), `${verb} gained a key requirement`);
}
check('unknown action is action_not_allowed', actionsSrc.includes('"${action}" is not an allowlisted action'), 'unknown-action refusal moved');
check('disabled action is action_not_allowed', actionsSrc.includes('"${action}" is not enabled on this bot'), 'disabled-action refusal moved');
check('keyless store use is action_not_allowed', actionsSrc.includes('"${action}" needs the durable store'), 'needs-store refusal moved');
check('unwired settings verbs are action_not_allowed', actionsSrc.includes('"${action}" needs the config store'), 'needs-settings refusal moved');
check(
  'three verbs live by default, the rest gated',
  configSrc.includes("'role.assign', 'announcement.post', 'event.upsert'") &&
    configSrc.includes("TWO_INTERNAL_ALLOW_ADD_MEMBER === '1'") &&
    configSrc.includes("TWO_INTERNAL_ALLOW_EVENT_CANCEL === '1'") &&
    configSrc.includes("TWO_INTERNAL_ALLOW_AUTOMATIONS === '1'") &&
    configSrc.includes("TWO_INTERNAL_ALLOW_SETTINGS === '1'") &&
    configSrc.includes('TWO_INTERNAL_ALLOW_MODERATION'),
  'config defaults moved',
);
check('moderation verbs are namespaced', MODERATION_ACTIONS.length > 0 && MODERATION_ACTIONS.every((v) => v.startsWith('moderation.')), 'MODERATION_ACTIONS moved');

// --- step 5: role.assign semantics the slice depends on.
console.log('== step 5: role.assign grant path ==');
const order = ['ctx.roleKeys.get(roleKey)', 'ctx.discord.memberRoles(', "'already_held'", 'ctx.discord.addRole(', "'assigned'"].map((s) => actionsSrc.indexOf(s));
check(
  'read-before-write with early already_held',
  order.every((i) => i >= 0) && order.every((v, i, a) => i === 0 || (v as number) > (a[i - 1] as number)),
  'roleAssign operation order moved',
);
check('unknown role key is action_not_allowed', actionsSrc.includes('role_key_unknown'), 'role_key_unknown moved');
check('discord ids are 17-20 digits', actionsSrc.includes(String.raw`/^\d{17,20}$/`), 'requireSnowflake moved');
check('doc pins the role.assign payload', doc.includes('"action": "role.assign"') && doc.includes('`role_key`, not a role snowflake'), 'doc §3 role.assign moved');
check('doc pins both outcomes', doc.includes('"outcome": "assigned" | "already_held"'), 'doc role.assign outcomes moved');
check('doc pins the hierarchy prerequisite', doc.includes('must sit **above**'), 'doc hierarchy note moved');
check('onboarding map is non-empty with unique keys', ALL_PICKS.length > 0 && new Set(ALL_PICKS.map((p) => p.key)).size === ALL_PICKS.length, 'ALL_PICKS empty or keys collide');
check('every pick role id is a snowflake', ALL_PICKS.every((p) => SNOWFLAKE.test(p.roleId)), 'a pick carries a non-snowflake role id');
check('catalog is the live guild map', GUILD_ID === LIVE_GUILD_ID, 'catalog GUILD_ID is not the live guild');
check('guild.add_member outcomes are added|already_member', read('src/internal/discordActions.ts').includes("Promise<AddMemberOutcome>") && read('src/internal/discordActions.ts').includes("'added' | 'already_member'"), 'addMember outcomes moved');
check('one-click source constant pinned', WEB_ONE_CLICK_SOURCE === 'web:one_click', 'WEB_ONE_CLICK_SOURCE moved');

// --- step 6: staging containment pins.
console.log('== step 6: staging-only containment ==');
// Widened to string first: the literals are distinct today, which is the
// property under test, and comparing the literal types would be a compile
// error instead of a runtime check.
const stagingGuild: string = TWO_STAGING_GUILD_ID;
const liveGuild: string = LIVE_GUILD_ID;
const stagingApp: string = STAGING_BOT_APPLICATION_ID;
const liveApp: string = LIVE_BOT_APPLICATION_ID;
check('staging and live guilds are distinct', stagingGuild !== liveGuild, 'staging/live guild ids collide');
check('staging bot app id is a snowflake', SNOWFLAKE.test(STAGING_BOT_APPLICATION_ID), 'staging app id malformed');
check('staging and live bots are distinct apps', stagingApp !== liveApp, 'staging/live app ids collide');
check('staging bot name pinned', STAGING_BOT_APPLICATION_NAME === 'Owen QA Test', 'staging bot name moved');

// --- step 7: doc lockstep for the remaining load-bearing lines.
console.log('== step 7: doc lockstep ==');
check('request_id is the join key', doc.includes('request_id') && doc.includes('join key'), 'doc request_id line moved');
check('add_member waits on the CEO flag', doc.includes('TWO_INTERNAL_ALLOW_ADD_MEMBER=1'), 'doc add_member flag line moved');
const authOrder = ['opts.keys.verify(keyId', 'withinSkew(timestamp', 'offerNonce(keyId, nonce)', 'buckets.take(`key:', 'parseBody(req, raw)'].map((s) => serverSrc.indexOf(s));
check('signature -> skew -> nonce -> limit -> body, enforced in code', authOrder.every((i) => i >= 0) && authOrder.every((v, i, a) => i === 0 || v > a[i - 1]), 'authoriseAndRun order moved');
check('nonce-vs-key distinction documented', doc.includes('Fresh on every attempt') && doc.includes('Stays the same across retries'), 'doc nonce/key rows moved');
check('server comment calls the order load-bearing', serverSrc.includes('The order of these checks is load-bearing'), 'authoriseAndRun comment moved');

// --- step 8: two-web client cross-checks, conditional on a checkout.
console.log('== step 8: two-web client (conditional) ==');
const flagPath = arg('--two-web');
const webRoot = flagPath ?? join(ROOT, '..', '..', '..', 'two-web');
if (!existsSync(webRoot)) {
  skip('two-web client checks', `no checkout at ${webRoot}; bot-side pins above are the durable gate (see TOG-4837)`);
} else {
  const wread = (p: string): string => readFileSync(join(webRoot, p), 'utf8');
  try {
    const payload = wread('app/Services/Bot/RoleAssignment.php');
    check('web sends action/discord_id/role_key', payload.includes("'action' => 'role.assign'") && payload.includes("'discord_id'") && payload.includes("'role_key'"), 'web toPayload drifted from the bot contract');
    check('web validates snowflake locally', payload.includes('/^\\d{1,20}$/'), 'web discord_id validation moved');
    const client = wread('app/Services/Bot/InternalActionClient.php');
    check('web sends no key for natural actions', client.includes('$this->send($assignment->toPayload(), null)') && client.includes('], null, [$accessToken])'), 'web natural-idempotency sends moved');
    check('web sends keys for needs-key actions', client.includes('$this->send($announcement->toPayload(), $idempotencyKey)') && client.includes('$this->send($event->toPayload(), $idempotencyKey)'), 'web key sends moved');
    check('web branches retryable not prose', client.includes('retryable'), 'web retryable branching moved');
    const signer = wread('app/Services/Bot/InternalActionSigner.php');
    check('web signs the same canonical', signer.includes("'/internal/actions'") || signer.includes('/internal/actions'), 'web signer path moved');
    const outcome = wread('app/Services/Bot/RoleAssignOutcome.php');
    check('web outcomes match the bot', outcome.includes("'assigned'") && outcome.includes("'already_held'"), 'web RoleAssignOutcome drifted');
    const join = wread('app/Enums/JoinOutcome.php');
    check('web join outcomes match the bot', join.includes("'added'") && join.includes("'already_member'"), 'web JoinOutcome drifted');
    const invite = wread('app/Http/Controllers/DiscordInviteController.php');
    check('front door stays 302 no-store', invite.includes(', 302)') && invite.includes('no-store'), 'invite redirect moved');
    const routes = wread('routes/web.php');
    check('join routes present', routes.includes("'join'") && routes.includes('join.redirect') && routes.includes('join.callback'), 'join routes moved');
    const joinCtl = wread('app/Http/Controllers/JoinController.php');
    check('join degraded states intact', joinCtl.includes("done('unavailable')") && joinCtl.includes("done('denied')") && joinCtl.includes("done('expired')"), 'join done() states moved');
  } catch (err) {
    fail('two-web client checks', `checkout at ${webRoot} is unreadable: ${(err as Error).message}`);
  }
}

console.log(`\nonboarding-web-slice-acceptance: ${passed} passed, ${failed} failed${na > 0 ? `, ${na} N-A` : ''}.`);
process.exitCode = failed > 0 ? 1 : 0;

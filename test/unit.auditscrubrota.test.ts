/**
 * TOG-10010: acknowledgement-shaped scrub regressions, offline and synthetic.
 *
 * OnboardingRota.acknowledgePrimary writes a pseudonymous community fact, not
 * an audit-collect endpoint. Pin that native shape (also checked against real
 * persistence in unit.rotanoticestate.test.ts) and defensively exercise decoded
 * payloads enriched with Discord user objects. These enriched envelopes are
 * fixtures, not a claim that the collector exports rota facts today.
 *
 * stripUsers retains ids for attribution; it is not a general PII eraser for
 * arbitrary free text or JSON-encoded strings. No DB, Discord, or credentials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommunityFactInput } from '../src/analytics/communityFacts.ts';
import { stripUsers } from '../scripts/audit-scrub.ts';

const SUBJECT = 'a1'.repeat(32);
const PRIMARY = 'b2'.repeat(32);
const GUILD = 'fixture-guild';
const KEY = `rota:${GUILD}:${SUBJECT}:welcome_rota_acknowledged`;

// Matches onboardingRota.ts write() / acknowledgePrimary(), before the store
// encodes metadata as JSON. HMAC ids here are fixture-only pseudonyms.
const ACK = {
  guildId: GUILD,
  eventType: 'welcome_rota_acknowledged',
  actorId: SUBJECT,
  sourceEventId: KEY,
  occurredAt: '2026-09-01T23:35:00.000Z',
  source: 'invite:campaign',
  idempotencyKey: KEY,
  metadata: {
    actionId: 'first-message', channelId: 'general',
    qualifyingActionAt: '2026-09-01T23:05:00.000Z',
    responderId: PRIMARY, role: 'primary',
    coverageBlock: 'America/Chicago 18:00–22:00 daily',
    sourceCohort: 'invite:campaign', rulesAcceptedAt: '2026-09-01T23:00:00.000Z',
  },
} satisfies Omit<CommunityFactInput, 'classification'>;

// Unique canaries, all fake. Extra/nested fields must be discarded rather
// than relying on an allowlist of today's Discord profile field names.
const IDENTITY = {
  username: 'fixture-rota-username',
  global_name: 'fixture-rota-global-name-名',
  discriminator: 'fixture-rota-discriminator',
  avatar: 'fixture-rota-avatar-hash',
  banner: 'fixture-rota-banner-hash',
  email: 'fixture-rota-email@example.invalid',
  phone: 'fixture-rota-phone-+15550109999',
  future_profile: { display_name: 'fixture-rota-future-display-name' },
};
const CANARIES = [
  ...Object.values(IDENTITY).filter((value): value is string => typeof value === 'string'),
  IDENTITY.future_profile.display_name,
];

function assertNoIdentity(value: unknown): void {
  const text = JSON.stringify(value);
  for (const canary of CANARIES) {
    assert.ok(!text.includes(canary), `embedded identity survived scrub: ${canary}`);
  }
}

function enrichedAcknowledgement() {
  return {
    ...structuredClone(ACK),
    interaction: {
      user: { id: PRIMARY, ...IDENTITY },
      member: { pending: false, user: { id: PRIMARY, ...IDENTITY } },
    },
    evidence: [
      { subject: { member: { user: { id: SUBJECT, ...IDENTITY } } } },
      { target_user: { id: SUBJECT, ...IDENTITY } },
      { inviter: { id: 'fixture-inviter', ...IDENTITY } },
      { application: { bot: { id: 'fixture-bot', ...IDENTITY, bot: true } } },
    ],
  };
}

const SCRUBBED_ACK = {
  ...ACK,
  interaction: { user: { id: PRIMARY }, member: { pending: false, user: { id: PRIMARY } } },
  evidence: [
    { subject: { member: { user: { id: SUBJECT } } } },
    { target_user: { id: SUBJECT } },
    { inviter: { id: 'fixture-inviter' } },
    { application: { bot: { id: 'fixture-bot' } } },
  ],
};

test('stripUsers preserves native rota acknowledgement facts and pseudonymous attribution', () => {
  const out = stripUsers(ACK);
  assert.deepEqual(out, ACK);
  assertNoIdentity(out);
  assert.deepEqual(stripUsers([ACK, ACK]), [ACK, ACK]);
});

test('rota identity tripwire rejects unsanitized adversarial fixtures', () => {
  const input = enrichedAcknowledgement();
  const text = JSON.stringify(input);
  for (const canary of CANARIES) assert.ok(text.includes(canary), `missing fixture: ${canary}`);
  assert.throws(() => assertNoIdentity(input), /embedded identity survived scrub/);
});

test('stripUsers removes nested user identities from enriched rota acknowledgement payloads', () => {
  const out = stripUsers(enrichedAcknowledgement());
  assert.deepEqual(out, SCRUBBED_ACK);
  assertNoIdentity(out);
});

test('stripUsers traverses mixed acknowledgement batches and missing-id user objects', () => {
  const input = [
    enrichedAcknowledgement(),
    { ...ACK, evidence: [null, { user: { ...IDENTITY } }, { bot: false },
      [{ inviter: { id: null, ...IDENTITY } }, { target_user: { ...IDENTITY } }]] },
    null,
  ];
  const out = stripUsers(input);
  assert.deepEqual(out, [
    SCRUBBED_ACK,
    { ...ACK, evidence: [null, { user: { id: null } }, { bot: false },
      [{ inviter: { id: null } }, { target_user: { id: null } }]] },
    null,
  ]);
  assertNoIdentity(out);
});

test('rota scrub preserves absent optional users and scalar bot flags', () => {
  const input = { ...ACK, interaction: { user: null, member: null },
    evidence: [{ inviter: null }, { target_user: null }, { bot: true }, { bot: false }] };
  const out = stripUsers(input);
  assert.deepEqual(out, input);
  assertNoIdentity(out);
});

test('rota acknowledgement scrubbing is non-mutating, repeatable and idempotent', () => {
  const input = enrichedAcknowledgement();
  const snapshot = structuredClone(input);
  const out = stripUsers(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(out, SCRUBBED_ACK);
  assert.deepEqual(stripUsers(input), out);
  assert.deepEqual(stripUsers(out), out);
  assertNoIdentity(out);
});

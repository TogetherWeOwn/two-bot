import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModerationDiscord } from '../src/moderation/discord.ts';
import { moderationAuditReason } from '../src/audit/moderationIdentity.ts';

const GUILD = '1545644954272137297';
const USER = '900000000000000001';
const SECRET = 's'.repeat(32);

test('Discord audit reason keeps the correlation prefix inside the encoded byte limit', async () => {
  let header = '';
  const discord = new ModerationDiscord({
    token: 'test',
    fetchImpl: async (_url, init) => {
      header = String((init?.headers as Record<string, string>)['X-Audit-Log-Reason']);
      return new Response(null, { status: 204 });
    },
  });
  for (const suffix of ['é'.repeat(512), `${'x'.repeat(511)}😀`, '\ud800']) {
    const reason = moderationAuditReason(SECRET, GUILD, 'key-1', 'moderation.ban', USER, suffix);
    await discord.ban(GUILD, USER, reason);

    assert.ok(header.length <= 512);
    const decoded = decodeURIComponent(header);
    assert.match(decoded, /^\[two-audit:v1:[a-f0-9]{32}:moderation\.ban:900000000000000001:[a-f0-9]{16}\] /);
  }
});

test('reason truncation past the encoded byte limit is logged, not silent', async () => {
  const discord = new ModerationDiscord({
    token: 'test',
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const reason = moderationAuditReason(SECRET, GUILD, 'key-1', 'moderation.ban', USER, 'é'.repeat(512));

  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await discord.ban(GUILD, USER, reason);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(stderr, /moderation_audit_reason_truncated/);
  const logged = JSON.parse(stderr.trim().split('\n').pop()!);
  assert.equal(logged.msg, 'moderation_audit_reason_truncated');
  assert.equal(logged.originalLength, reason.length);
  assert.ok(logged.truncatedLength < logged.originalLength);
  assert.ok(logged.encodedLength <= 512);
});

test('a reason that fits well within the byte limit is never reported as truncated', async () => {
  const discord = new ModerationDiscord({
    token: 'test',
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const reason = moderationAuditReason(SECRET, GUILD, 'key-1', 'moderation.ban', USER, 'spam');

  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await discord.ban(GUILD, USER, reason);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.doesNotMatch(stderr, /moderation_audit_reason_truncated/);
});

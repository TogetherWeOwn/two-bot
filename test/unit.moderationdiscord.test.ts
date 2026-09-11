import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModerationDiscord } from '../src/moderation/discord.ts';
import { moderationAuditReason } from '../src/audit/moderationIdentity.ts';

const GUILD = '1545644954272137297';
const USER = '900000000000000001';

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
    const reason = moderationAuditReason(GUILD, 'key-1', 'moderation.ban', USER, suffix);
    await discord.ban(GUILD, USER, reason);

    assert.ok(header.length <= 512);
    const decoded = decodeURIComponent(header);
    assert.match(decoded, /^\[two-audit:v1:[a-f0-9]{32}:moderation\.ban:900000000000000001\] /);
  }
});

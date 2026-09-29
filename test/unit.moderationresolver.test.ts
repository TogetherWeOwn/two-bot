import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionError } from '../src/internal/errors.ts';
import { RestModerationResolver } from '../src/moderation/resolver.ts';

function resolverWithBody(body: string): RestModerationResolver {
  return new RestModerationResolver({
    token: 'test',
    botUserId: '900000000000000001',
    fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
  });
}

test('channel() maps malformed 200 JSON body to typed ActionError', async () => {
  const resolver = resolverWithBody('not-json{{{');
  await assert.rejects(resolver.channel('123'), (err: unknown) => {
    assert.ok(err instanceof ActionError, `expected ActionError, got ${err}`);
    assert.equal(err.code, 'discord_unavailable');
    assert.equal(err.logReason, 'discord_json_parse');
    return true;
  });
});

test('channel() maps empty 200 body to typed ActionError, not SyntaxError', async () => {
  const resolver = resolverWithBody('');
  await assert.rejects(resolver.channel('123'), (err: unknown) => {
    assert.ok(err instanceof ActionError, `expected ActionError, got ${err}`);
    assert.ok(!(err instanceof SyntaxError));
    assert.equal((err as ActionError).code, 'discord_unavailable');
    return true;
  });
});

test('channel() still parses a valid 200 body', async () => {
  const resolver = resolverWithBody(JSON.stringify({ id: '123', type: 0 }));
  assert.deepEqual(await resolver.channel('123'), { channelId: '123', type: 0 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { announcementsProofConfig, assertProofIdentity, ownsProofMessage, parseAnnouncementsProof, proofSchema } from '../scripts/staging-announcements-state.ts';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID, STAGING_SERVER_NAME, LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID } from '../src/staging/spec.ts';

const token = (id: string) => `${Buffer.from(id).toString('base64')}.fixture.fixture`;
const env = {
  DISCORD_STAGING_BOT_TOKEN: token(STAGING_BOT_APPLICATION_ID),
  TWO_STAGING_DATABASE_URL: 'postgres://test:fixture@localhost/two_bot_staging',
};

test('announcements proof allows only an explicit staging application, guild and database', () => {
  assert.equal(announcementsProofConfig(env).token, env.DISCORD_STAGING_BOT_TOKEN);
  for (const patch of [
    { DISCORD_STAGING_BOT_TOKEN: undefined, DISCORD_TOKEN: env.DISCORD_STAGING_BOT_TOKEN },
    { DISCORD_STAGING_BOT_TOKEN: token(LIVE_BOT_APPLICATION_ID) },
    { DISCORD_STAGING_BOT_TOKEN: token('123456789012345678') },
    { DISCORD_STAGING_GUILD_ID: LIVE_GUILD_ID },
    { TWO_STAGING_DATABASE_URL: undefined, DATABASE_URL: env.TWO_STAGING_DATABASE_URL },
    { TWO_STAGING_DATABASE_URL: 'postgres://test:fixture@localhost/two_bot_live' },
    { TWO_STAGING_DATABASE_URL: 'postgres://test:fixture@localhost/not_really_staging' },
    { TWO_STAGING_DATABASE_URL: `${env.TWO_STAGING_DATABASE_URL}?options=-csearch_path=public` },
    { TWO_STAGING_DATABASE_URL: `${env.TWO_STAGING_DATABASE_URL}#fragment` },
    { TWO_STAGING_DATABASE_URL: 'https://example.com/two_bot_staging' },
  ]) assert.throws(() => announcementsProofConfig({ ...env, ...patch }));
});

test('announcements proof checks remote identity independently of token decoding', () => {
  assertProofIdentity(STAGING_BOT_APPLICATION_ID, { id: TWO_STAGING_GUILD_ID, name: STAGING_SERVER_NAME });
  for (const [app, id, name] of [
    [LIVE_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID, STAGING_SERVER_NAME],
    [STAGING_BOT_APPLICATION_ID, LIVE_GUILD_ID, STAGING_SERVER_NAME],
    [STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID, 'not TWO Staging'],
  ]) assert.throws(() => assertProofIdentity(app!, { id: id!, name: name! }));
});

test('announcements cleanup requires both QA bot author and the unique run marker', () => {
  const marker = 'TOG-3845:fixture';
  assert.equal(ownsProofMessage({ author: { id: STAGING_BOT_APPLICATION_ID }, content: marker }, marker), true);
  assert.equal(ownsProofMessage({ author: { id: LIVE_BOT_APPLICATION_ID }, content: marker }, marker), false);
  assert.equal(ownsProofMessage({ author: { id: STAGING_BOT_APPLICATION_ID }, content: 'unrelated' }, marker), false);
  assert.equal(ownsProofMessage({}, marker), false);
});

const runId = 'a'.repeat(24);
const proof = {
  version: 1, runId, schema: proofSchema(runId), guildId: TWO_STAGING_GUILD_ID,
  applicationId: STAGING_BOT_APPLICATION_ID, head: 'b'.repeat(40),
  startedAt: '2026-09-22T00:00:00Z', finishedAt: '2026-09-22T00:01:00Z',
  channelId: '123456789012345678', deniedChannelId: '123456789012345679', eventId: '123456789012345680',
  messageIds: ['123456789012345681'], checks: [{ name: 'fixture', pass: true, detail: 'fixture only' }],
};
test('announcements report parsing rejects routing/schema injection and incomplete proof', () => {
  assert.deepEqual(parseAnnouncementsProof(proof), proof);
  for (const patch of [
    { schema: 'public' }, { runId: 'a"; DROP SCHEMA public; --' }, { guildId: LIVE_GUILD_ID },
    { applicationId: LIVE_BOT_APPLICATION_ID }, { eventId: '../other' }, { eventId: null },
    { deniedChannelId: null }, { head: 'main' }, { startedAt: 'unknown' },
    { messageIds: [] }, { checks: [] }, { checks: [{ name: 'fixture', pass: 'yes', detail: '' }] },
  ]) assert.throws(() => parseAnnouncementsProof({ ...proof, ...patch }));
  assert.throws(() => parseAnnouncementsProof(null));
  assert.throws(() => proofSchema('public'));
});

test('announcements verifier fails closed without a report, before networking', () => {
  const run = spawnSync(process.execPath, ['scripts/staging-verify.ts', '--case=announcements'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ...env },
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /announcements requires --proof=/);
});

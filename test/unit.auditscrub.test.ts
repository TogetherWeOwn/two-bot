/**
 * The PII scrubber behind `npm run audit:collect`, pinned two ways.
 *
 * WHY THIS EXISTS (TOG-7216). Discord attaches whole user objects to invites
 * and integrations. The collector's original scrubber covered `user` /
 * `inviter` / `target_user` but missed `integrations[].application.bot` - a
 * full user object (username, global_name, avatar, discriminator, banner)
 * that landed verbatim in the tracked `audit/raw/integrations.json`. The
 * synthetic cases prove the rule still refuses things (a guard nobody has
 * watched fail is not a guard); the committed-tree cases fail if a raw dump
 * is ever re-tracked or a derived table reintroduces an embedded identity.
 *
 * TOG-8963 removed `audit/raw/` from HEAD (member user IDs) and gitignored
 * it. The collector still scrubs through this module and rebuilds raw/
 * locally; the fence below moved from "tracked raw artifacts" to "nothing
 * raw is tracked, and the kept tables stay clean".
 *
 * Hermetic: pure function plus read-only scans of tracked files. No DB, no Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripUsers } from '../scripts/audit-scrub.ts';

const ROOT = resolve(import.meta.dirname, '..');

// Same pattern as test/unit.repohygiene.test.ts: the Docker image has no .git,
// so the tracked-state case can only run from a git checkout. It never runs
// anywhere else, and it is never skipped in CI.
function isGitWorkTree(): boolean {
  try {
    return git('rev-parse', '--is-inside-work-tree') === 'true';
  } catch {
    return false;
  }
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), ...args], {
    encoding: 'utf8',
  }).trim();
}

test('stripUsers reduces inviter/user/target_user objects to { id }', () => {
  const input = {
    code: 'abc',
    inviter: { id: '1', username: 'someone', global_name: 'Some One', avatar: 'hash' },
    target_user: { id: '2', username: 'other', discriminator: '0' },
    channel: { id: '3', name: 'general' },
  };
  assert.deepEqual(stripUsers(input), {
    code: 'abc',
    inviter: { id: '1' },
    target_user: { id: '2' },
    channel: { id: '3', name: 'general' },
  });
});

test('stripUsers reduces integrations[].application.bot (the TOG-7216 leak)', () => {
  const input = [
    {
      id: 'int-1',
      name: 'Twitch',
      type: 'twitch',
      user: { id: '10', username: 'streamer' },
      account: { id: 'acc', name: 'streamer-name' },
      application: {
        id: 'app-1',
        name: 'Blessed',
        bot: {
          id: '20',
          username: 'Blessed',
          global_name: 'Blessed',
          avatar: 'h',
          discriminator: '0',
          banner: 'b',
          bot: true,
        },
      },
    },
  ];
  const out = stripUsers(input) as Array<Record<string, any>>;
  assert.deepEqual(out[0].application.bot, { id: '20' });
  assert.deepEqual(out[0].user, { id: '10' });
  // Non-user objects pass through untouched.
  assert.equal(out[0].account.name, 'streamer-name');
  assert.equal(out[0].application.name, 'Blessed');
});

test('stripUsers leaves boolean bot flags and plain values alone', () => {
  assert.deepEqual(stripUsers({ id: '1', bot: true }), { id: '1', bot: true });
  assert.deepEqual(stripUsers([1, 'a', null]), [1, 'a', null]);
  assert.deepEqual(stripUsers({ id: null }), { id: null });
});

function identityLeaks(data: unknown, name: string): string[] {
  const leaks: string[] = [];
  const walk = (o: unknown, path: string): void => {
    if (Array.isArray(o)) {
      o.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (
          (k === 'user' || k === 'inviter' || k === 'target_user' || k === 'bot') &&
          v &&
          typeof v === 'object'
        ) {
          const extra = Object.keys(v as Record<string, unknown>).filter((sk) => sk !== 'id');
          if (extra.length > 0) leaks.push(`${path}/${k}: ${extra.join(',')}`);
        }
        walk(v, `${path}/${k}`);
      }
    }
  };
  walk(data, name);
  return leaks;
}

test('no raw dump is tracked (TOG-8963)', { skip: !isGitWorkTree() }, () => {
  // audit/raw/ was deleted from HEAD because it carried community member
  // user IDs (28 thread owner_ids, 16 invite inviter ids, guild owner_id,
  // automod creator_id, permanent invite codes). A re-tracked dump must fail
  // here the day it lands, not the day someone re-reads the collector.
  const tracked = git('ls-files', '--', 'audit/raw', 'data/server-audit-*.json')
    .split('\n')
    .filter((line) => line.length > 0);
  assert.deepEqual(tracked, [], `raw dumps must not be tracked: ${tracked.join(', ')}`);
});

test('the kept derived tables carry no embedded user identity fields', () => {
  // Every kept table, not just the ones that have leaked before: a future
  // report column (emoji authors, sticker users, thread owners) must fail
  // here the day it lands, not the day someone re-reads the scrubber.
  //
  // KNOWN EXCEPTION, accepted by the CEO on TOG-8963: audit/invites.csv keeps
  // its inviter_id column (server/role/channel ids are public by nature).
  // Everything else identity-shaped is refused.
  const IDENTITY_COLUMN = /username|avatar|discriminator|global_name|email|phone/i;
  for (const name of [
    'audit/summary.json',
    'audit/channels.csv',
    'audit/roles.csv',
    'audit/invites.csv',
    // The channel table's spec-shaped duplicate. It carries no people, only
    // per-channel traffic and verdicts — but it must stay that way.
    'data/server-audit-2026-08-19.csv',
  ]) {
    const rawText = readFileSync(resolve(ROOT, name), 'utf8');
    if (name.endsWith('.csv')) {
      const header = rawText.split('\n', 1)[0] ?? '';
      const bad = header
        .split(',')
        .map((c) => c.trim())
        .filter((c) => IDENTITY_COLUMN.test(c));
      assert.deepEqual(bad, [], `${name} must not grow identity columns`);
      continue;
    }
    assert.deepEqual(
      identityLeaks(JSON.parse(rawText), name),
      [],
      `${name} must not embed user identity fields`,
    );
  }
});

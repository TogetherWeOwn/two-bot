/**
 * The PII scrubber behind `npm run audit:collect`, pinned two ways.
 *
 * WHY THIS EXISTS (TOG-7216). Discord attaches whole user objects to invites
 * and integrations. The collector's original scrubber covered `user` /
 * `inviter` / `target_user` but missed `integrations[].application.bot` - a
 * full user object (username, global_name, avatar, discriminator, banner)
 * that landed verbatim in the tracked `audit/raw/integrations.json`. The
 * synthetic cases prove the rule still refuses things (a guard nobody has
 * watched fail is not a guard); the live-tree case fails on any tracked
 * artifact that reintroduces an embedded identity.
 *
 * Hermetic: pure function plus read-only scans of tracked JSON. No DB, no Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripUsers } from '../scripts/audit-scrub.ts';

const ROOT = resolve(import.meta.dirname, '..');

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

test('tracked audit/raw artifacts carry no embedded user identity fields', () => {
  // Every raw artifact, not just the two that have leaked before: a future
  // collector endpoint (emoji authors, sticker users, thread owners) must fail
  // here the day it lands, not the day someone re-reads the scrubber.
  for (const name of [
    'active_threads.json',
    'activity.json',
    'automod_rules.json',
    'channels.json',
    'forum_threads.json',
    'guild.json',
    'integrations.json',
    'invites.json',
    'members.json',
    'meta.json',
    'onboarding.json',
    'preview.json',
    'roles.json',
    'scheduled_events.json',
    'server_totals.json',
    'thread_activity.json',
    'vanity_url.json',
    'welcome_screen.json',
  ]) {
    const data: unknown = JSON.parse(readFileSync(resolve(ROOT, 'audit/raw', name), 'utf8'));
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
    assert.deepEqual(leaks, [], `${name} must not embed user identity fields`);
  }
});

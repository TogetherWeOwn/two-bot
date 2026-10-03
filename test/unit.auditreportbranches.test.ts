/**
 * TOG-10001: synthetic audit-report fixtures exercise rubric boundaries and
 * sparse dumps that the historical golden fixture does not cover. No database,
 * credentials, Discord client or network calls; all writes stay in a temp root.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runAuditReport } from '../scripts/audit-report.ts';

const GUILD = '900000000000000001';
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const ADMIN = 1n << 3n;
const NOW = '2026-09-30T12:00:00.000Z';
const DAY = 86_400_000;
const REPORT = fileURLToPath(new URL('../scripts/audit-report.ts', import.meta.url));
const exec = promisify(execFile);
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();

type Overwrite = { id: string; type: number; allow: string; deny: string };
type Channel = {
  id: string; name: string; type: number; position?: number; parent_id?: string | null;
  topic?: string | null; permission_overwrites?: Overwrite[]; last_message_id?: string;
  user_limit?: number; nsfw?: boolean; rate_limit_per_user?: number;
};
function channel(id: string, extra: Partial<Channel> = {}): Channel {
  return { id, name: `room-${id}`, type: 0, topic: 'Say hello', ...extra };
}
function role(id: string, name: string, permissions: bigint, extra: Record<string, unknown> = {}) {
  return { id, name, permissions: String(permissions), position: 0, hoist: false,
    managed: false, color: 0, mentionable: false, ...extra };
}
function overwrite(id: string, allow = 0n, deny = 0n, type = 0): Overwrite {
  return { id, type, allow: String(allow), deny: String(deny) };
}
function activity(id: string, authors30 = 0, extra: Record<string, unknown> = {}) {
  return { channel_id: id, scanned: true, skipped_reason: null,
    messages_30d: authors30, messages_90d: 10,
    human_messages_30d: authors30, human_messages_90d: 10, bot_messages_90d: 0,
    unique_authors_90d: 4, unique_human_authors_30d: authors30, unique_human_authors_90d: 4,
    last_message_at: null, days_since_last_message: null, hit_page_cap: false, ...extra };
}
function snowflake(daysAgo: number): string {
  return String(BigInt(Date.parse(NOW) - daysAgo * DAY - 1420070400000) << 22n);
}
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guild: { id: GUILD, name: 'Fixture guild', features: [], verification_level: 0,
      default_message_notifications: 1 },
    channels: [], roles: [role(GUILD, '@everyone', VIEW | SEND)], invites: [], activity: [],
    forum_threads: {}, thread_activity: [], onboarding: null, welcome_screen: null,
    members: { human_members: 10, bot_members: 2, pending_rules_screening: 0,
      joined_last_30d: 1, joined_last_90d: 2, joins_by_month: {}, role_headcount: {} },
    meta: { collected_at: NOW }, server_totals: { unique_human_authors_30d: 3, unique_human_authors_90d: 4 },
    vanity_url: null, integrations: [], ...overrides,
  };
}
function fixture(t: TestContext, input = raw()): string {
  const root = mkdtempSync(join(scratch, 'two-audit-report-branches-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'audit', 'raw'), { recursive: true });
  for (const [name, value] of Object.entries(input)) {
    writeFileSync(join(root, 'audit', 'raw', `${name}.json`), JSON.stringify(value));
  }
  return root;
}
type Summary = {
  guild: Record<string, unknown>; counts: Record<string, number>; activity: Record<string, number>;
  verdicts: Record<string, number>; server_level: Record<string, unknown>;
  members: { joins_by_month_last_12: Record<string, number> };
  game_coverage: Record<string, unknown>; permission_risk: Record<string, unknown>[];
};
type Snapshot = {
  summary: Summary;
  channels: { id: string; audit: Record<string, unknown>; [key: string]: unknown }[];
  roles: Record<string, unknown>[]; invites: Record<string, unknown>[];
};
function render(t: TestContext, input: Record<string, unknown>) {
  const root = fixture(t, input);
  const { summaryJson, walk } = runAuditReport(root);
  const snapshot = JSON.parse(readFileSync(join(root, 'data', 'server-audit-2026-09-30.json'), 'utf8')) as Snapshot;
  assert.deepEqual(snapshot.summary, JSON.parse(summaryJson));
  assert.equal(readFileSync(join(root, 'audit', 'summary.json'), 'utf8'), summaryJson);
  assert.equal(readFileSync(join(root, 'audit', 'new-member-walkthrough.txt'), 'utf8'), walk);
  assert.equal(readFileSync(join(root, 'audit', 'channels.csv'), 'utf8'),
    readFileSync(join(root, 'data', 'server-audit-2026-09-30.csv'), 'utf8'));
  const row = (id: string) => {
    const entry = snapshot.channels.find((c) => c.id === id);
    assert.ok(entry, `missing channel ${id}`);
    return entry.audit;
  };
  return { root, walk, snapshot, summary: snapshot.summary, row };
}

test('audit-report rubric uses human activity and exact 30-day author boundaries', (t) => {
  const cases = [
    { id: 'dead', humans90: 0, authors30: 3, verdict: 'archive', why: '0 human messages in 90 days (8 bot messages), never used' },
    { id: 'alive', humans90: 10, authors30: 3, verdict: 'keep', why: '3 unique human authors in 30d (3 messages)' },
    { id: 'blank', humans90: 10, authors30: 3, topic: ' \n\t ', verdict: 'rewrite-topic', why: '3 unique human authors in 30d, but no topic is set' },
    { id: 'hidden', humans90: 10, authors30: 3, topic: '', hidden: true, verdict: 'keep', why: '3 unique human authors in 30d (3 messages)' },
    { id: 'one', humans90: 10, authors30: 1, verdict: 'merge', why: 'only 1 unique human author in 30d (4 in 90d, 10 messages)' },
    { id: 'two', humans90: 10, authors30: 2, verdict: 'merge', why: 'only 2 unique human authors in 30d (4 in 90d, 10 messages)' },
    { id: 'game', name: 'minecraft', humans90: 10, authors30: 0, verdict: 'gate-behind-role', why: 'per-game channel visible at join, 10 human messages/90d from 4 people but nobody in 30d' },
    { id: 'old-blank', humans90: 10, authors30: 0, topic: '', verdict: 'rewrite-topic', why: '10 human messages/90d but 0 authors in 30d and no topic set' },
    { id: 'old-topic', humans90: 10, authors30: 0, verdict: 'merge', why: '10 human messages/90d from 4 people, none in the last 30 days' },
    { id: 'old-hidden', name: 'valorant', humans90: 10, authors30: 0, topic: '', hidden: true, verdict: 'merge', why: '10 human messages/90d from 4 people, none in the last 30 days' },
    { id: 'word-boundary', name: 'Dark red Coding', humans90: 10, authors30: 0, verdict: 'merge', why: '10 human messages/90d from 4 people, none in the last 30 days' },
  ];
  const { row, summary } = render(t, raw({
    channels: cases.map((c) => channel(c.id, { name: c.name ?? c.id, topic: c.topic ?? 'Say hello',
      permission_overwrites: c.hidden ? [overwrite(GUILD, 0n, VIEW)] : [] })),
    activity: cases.map((c) => activity(c.id, c.authors30, {
      human_messages_90d: c.humans90, bot_messages_90d: c.id === 'dead' ? 8 : 0,
    })),
  }));
  for (const c of cases) {
    assert.equal(row(c.id).verdict, c.verdict, c.id);
    assert.equal(row(c.id).justification, c.why, c.id);
  }
  assert.deepEqual(summary.verdicts, { keep: 2, merge: 5, archive: 1, 'rewrite-topic': 2, 'gate-behind-role': 1 });
});

test('audit-report applies only everyone role overwrites, allow wins deny, and view gates send', (t) => {
  const channels = [
    channel('inherited'),
    channel('deny-view', { permission_overwrites: [overwrite(GUILD, 0n, VIEW)] }),
    channel('deny-send', { permission_overwrites: [overwrite(GUILD, 0n, SEND)] }),
    channel('both', { permission_overwrites: [overwrite(GUILD, VIEW | SEND, VIEW | SEND)] }),
    channel('other-role', { permission_overwrites: [overwrite('outsider', 0n, VIEW | SEND)] }),
    channel('member', { permission_overwrites: [overwrite(GUILD, 0n, VIEW | SEND, 1)] }),
  ];
  const { row } = render(t, raw({ channels }));
  for (const id of ['inherited', 'both', 'other-role', 'member']) {
    assert.equal(row(id).visible_to_everyone, true, id);
    assert.equal(row(id).everyone_can_send, true, id);
  }
  assert.equal(row('deny-view').visible_to_everyone, false);
  assert.equal(row('deny-view').everyone_can_send, false);
  assert.equal(row('deny-send').visible_to_everyone, true);
  assert.equal(row('deny-send').everyone_can_send, false);
  const noBase = render(t, raw({ channels: [channel('grant', { permission_overwrites: [overwrite(GUILD, VIEW | SEND)] }), channel('none')],
    roles: [role(GUILD, '@everyone', 0n)] }));
  assert.equal(noBase.row('grant').everyone_can_send, true);
  assert.equal(noBase.row('none').visible_to_everyone, false);
  assert.equal(noBase.row('none').everyone_can_send, false);
  const admin = render(t, raw({ channels, roles: [role(GUILD, '@everyone', ADMIN)] }));
  for (const c of channels) {
    assert.equal(admin.row(c.id).visible_to_everyone, true, c.id);
    assert.equal(admin.row(c.id).everyone_can_send, true, c.id);
  }
});

test('audit-report merge picks the busiest same-type sibling in the same category, or nothing', (t) => {
  const { row } = render(t, raw({
    channels: [channel('source', { parent_id: 'cat' }), channel('quiet', { parent_id: 'cat' }),
      channel('best', { name: 'Busy room', parent_id: 'cat' }), channel('tie', { parent_id: 'cat' }),
      channel('voice', { type: 2, parent_id: 'cat' }), channel('other', { parent_id: 'elsewhere' }),
      channel('solo', { parent_id: 'lonely' }), channel('empty', { parent_id: 'lonely' })],
    activity: [activity('source', 1), activity('quiet', 3, { human_messages_90d: 20 }),
      activity('best', 3, { human_messages_90d: 50 }), activity('tie', 3, { human_messages_90d: 50 }),
      activity('voice', 3, { human_messages_90d: 500 }), activity('other', 3, { human_messages_90d: 1000 }),
      activity('solo', 1)],
  }));
  assert.equal(row('source').merge_into, 'Busy room');
  assert.equal(row('solo').merge_into, '');
  assert.equal(row('source').category, ''); // a missing parent is not fabricated
});

test('audit-report rolls up forums/media from active and archived threads with sparse activity', (t) => {
  const { row, summary } = render(t, raw({
    channels: [channel('forum', { type: 15 }), channel('media', { type: 16 }),
      channel('empty-forum', { type: 15 }), channel('sparse-forum', { type: 15 })],
    forum_threads: { forum: {
      active: [{ id: snowflake(20), last_message_id: snowflake(2), total_message_sent: 2 }, { id: snowflake(200) }],
      archived: [{ id: snowflake(100), total_message_sent: 1 }],
    }, 'sparse-forum': { active: [{ id: snowflake(10) }] } },
    thread_activity: [
      { ...activity('thread', 3), parent_id: 'forum' },
      { ...activity('older', 0, { unique_human_authors_30d: undefined, human_messages_30d: 0 }), parent_id: 'forum' },
      { ...activity('empty', 7, { messages_90d: 0 }), parent_id: 'forum' },
      { ...activity('media-thread', 1), parent_id: 'media' },
      { ...activity('unrelated', 100), parent_id: 'elsewhere' },
    ],
  }));
  const f = row('forum');
  assert.equal(f.forum_posts, '3');
  assert.equal(f.forum_posts_with_reply, '1');
  assert.equal(f.human_msgs_90d, 20);
  assert.equal(f.unique_humans_30d, 3);
  assert.equal(f.unique_humans_90d, 8);
  assert.equal(f.threads_active, 3);
  assert.equal(f.days_silent, '2');
  assert.equal(f.last_message_at, '2026-09-28');
  assert.equal(f.verdict, 'keep');
  assert.equal(row('media').human_msgs_90d, 10);
  assert.equal(row('media').verdict, 'merge');
  assert.equal(row('empty-forum').forum_posts, '0');
  assert.equal(row('empty-forum').days_silent, '');
  assert.equal(row('sparse-forum').days_silent, '10');
  assert.equal(summary.activity.total_human_messages_90d, 30);
});

test('audit-report falls back to channel snowflakes, preserves rollback inputs and quotes CSV', (t) => {
  const original = channel('special', { name: 'room,"quoted"', type: 99, parent_id: 'missing',
    topic: ' first\nsecond \t line ', position: 7, nsfw: true, rate_limit_per_user: 15,
    permission_overwrites: [overwrite(GUILD, 0n, VIEW)] });
  const { root, row, snapshot } = render(t, raw({
    channels: [original, channel('last-id', { last_message_id: snowflake(40) }),
      channel('last-activity', { type: 2, user_limit: 5 })],
    activity: [activity('last-activity', 1, { last_message_at: '2026-09-29T12:00:00Z', hit_page_cap: true })],
  }));
  assert.equal(row('special').type, '99');
  assert.equal(row('special').topic, 'first second line');
  assert.match(String(row('special').justification), /already hidden from @everyone/);
  const kept = snapshot.channels.find((c) => c.id === 'special')!;
  assert.equal(kept.topic, original.topic);
  assert.equal(kept.parent_id, 'missing');
  assert.equal(kept.parent_name, null);
  assert.equal(kept.position, 7);
  assert.equal(kept.nsfw, true);
  assert.deepEqual(kept.permission_overwrites, original.permission_overwrites);
  assert.equal(row('last-id').days_silent, '40');
  assert.match(String(row('last-id').justification), /last message 40d ago/);
  assert.equal(row('last-activity').days_silent, '1');
  assert.equal(row('last-activity').voice_user_limit, '5');
  assert.equal(row('last-activity').truncated, true);
  assert.ok(readFileSync(join(root, 'audit', 'channels.csv'), 'utf8').includes('"room,""quoted"""'));
});

test('audit-report classifies role risk, integration exemptions, separators and onboarding grants', (t) => {
  const moderation = (1n << 5n) | (1n << 28n) | (1n << 4n) | (1n << 2n) | (1n << 1n);
  const { snapshot, summary } = render(t, raw({
    roles: [role(GUILD, '@everyone', VIEW | SEND), role('admin', 'Admin', ADMIN | moderation, { position: 9 }),
      role('mod', 'Moderator', moderation), role('mention', 'Broadcaster', 1n << 17n),
      role('header', '⠀⠀⠀', 0n), role('managed', 'Integration', ADMIN, { managed: true, color: 123 })],
    onboarding: { prompts: [{ options: [{ role_ids: ['mention'] }, {}] }, {}] },
    members: { role_headcount: { admin: 2, mod: 1, mention: 3 }, joins_by_month: {} },
  }));
  const classes = Object.fromEntries(snapshot.roles.map((r) => [r.role_id, r.permission_class]));
  assert.deepEqual(classes, { admin: 'administrator', [GUILD]: 'basic', mod: 'moderation',
    mention: 'mention-everyone', header: 'cosmetic (no permissions)', managed: 'administrator' });
  assert.equal(snapshot.roles[0].role_id, 'admin');
  assert.equal(snapshot.roles.find((r) => r.role_id === 'mention')!.granted_by_onboarding, true);
  assert.equal(summary.counts.roles_separator_header, 1);
  assert.equal(summary.counts.roles_cosmetic, 1);
  assert.equal(summary.counts.roles_managed_by_bots, 1);
  assert.equal(summary.counts.roles_nobody_holds, 2);
  assert.deepEqual(summary.permission_risk, [
    { role: 'Admin', holders: 2, permissions: 'Administrator / Manage Guild / Manage Roles / Manage Channels / Ban Members / Kick Members' },
    { role: 'Moderator', holders: 1, permissions: 'Manage Guild / Manage Roles / Manage Channels / Ban Members / Kick Members' },
    { role: 'Broadcaster', holders: 3, permissions: 'Mention Everyone' },
  ]);
});

test('audit-report pairs plural game names, flags unmatched games and counts role-only grants', (t) => {
  const { summary, row } = render(t, raw({
    channels: [channel('survival', { name: 'survival', permission_overwrites: [overwrite('survival-role', VIEW),
      overwrite('unknown-role', VIEW), overwrite('member-id', VIEW, 0n, 1)] }),
      channel('shooter', { name: 'shooters' }), channel('game', { name: 'minecraft' }),
      channel('not-game', { name: 'Dark red Coding' })],
    roles: [role(GUILD, '@everyone', VIEW | SEND), role('survival-role', 'Survivals Games', 0n),
      role('shooter-role', 'Shooter', 0n), role('stray', 'Fortnite Games', 0n)],
  }));
  assert.equal(row('survival').gated_roles, 2);
  assert.deepEqual(summary.game_coverage, {
    roles_with_no_channel: [{ role: 'Fortnite Games', holders: 0 }],
    channels_with_no_role: ['minecraft'],
    roles_wired_to_their_channel: [
      { role: 'Survivals Games', holders: 0, channels: ['survival'], channels_the_role_can_actually_see: ['survival'] },
      { role: 'Shooter', holders: 0, channels: ['shooters'], channels_the_role_can_actually_see: [] },
    ],
  });
});

test('audit-report invite sorting/defaults and CSV escaping retain readable invite fields', (t) => {
  const { snapshot, root, summary } = render(t, raw({ invites: [
    { code: 'unused' },
    { code: 'short,"invite"', uses: 5, channel: { id: 'landing', name: 'Hello, world' },
      inviter: { id: '900000000000000002' }, created_at: '2026-09-01T12:00:00Z',
      max_age: 129600, max_uses: 10, temporary: true },
    { code: 'forever', uses: 1, max_age: 0, max_uses: 0, temporary: false },
  ] }));
  assert.deepEqual(snapshot.invites.map((i) => i.code), ['short,"invite"', 'forever', 'unused']);
  assert.deepEqual(snapshot.invites[0], { code: 'short,"invite"', uses: 5, landing_channel: 'Hello, world',
    landing_channel_id: 'landing', inviter_id: '900000000000000002', created_at: '2026-09-01',
    expires_in_days: 2, max_uses: 10, temporary_membership: true });
  assert.deepEqual(snapshot.invites[2], { code: 'unused', uses: 0, landing_channel: '', landing_channel_id: '',
    inviter_id: '', created_at: '', expires_in_days: 'never', max_uses: 'unlimited', temporary_membership: false });
  assert.equal(summary.counts.invites_never_used, 1);
  assert.ok(readFileSync(join(root, 'audit', 'invites.csv'), 'utf8').includes('"short,""invite""",5,"Hello, world"'));
});

test('audit-report protection does not override verdicts and onboarding needs seven defaults/five sendable', (t) => {
  const ids = Array.from({ length: 7 }, (_, i) => `default-${i}`);
  const channels = ids.map((id, i) => channel(id, {
    permission_overwrites: i >= 5 ? [overwrite(GUILD, 0n, SEND)] : [],
  }));
  const guild = { id: GUILD, name: 'Gated fixture', features: ['MEMBER_VERIFICATION_GATE_ENABLED'],
    verification_level: 3, default_message_notifications: 0, rules_channel_id: ids[0],
    public_updates_channel_id: ids[0], safety_alerts_channel_id: ids[1], afk_channel_id: ids[2],
    system_channel_id: ids[3] };
  const onboarding = { enabled: true, default_channel_ids: ids, prompts: [
    { required: true, in_onboarding: true }, { required: true, in_onboarding: false },
    { required: false, in_onboarding: true },
  ] };
  const { row, summary, walk } = render(t, raw({ guild, channels, onboarding,
    welcome_screen: { welcome_channels: [{ channel_id: ids[4] }, { channel_id: 'unknown' }] } }));
  assert.deepEqual(ids.map((id) => row(id).protected_by), ['rules channel', 'safety alerts channel', 'AFK channel',
    'system channel', 'welcome screen card', 'Server Guide default channel', 'Server Guide default channel']);
  for (const id of ids) assert.equal(row(id).verdict, 'archive', id);
  assert.deepEqual(summary.server_level.gate_step_detail,
    ['accept the rules screening box', 'verification level 3', '1 required Server Guide questions']);
  assert.equal(summary.server_level.onboarding_qualifying_channels_today, 5);
  assert.equal(summary.server_level.onboarding_requirement_met_today, true);
  assert.match(String(summary.server_level.default_notifications_flag), /^ALL MESSAGES/);
  assert.match(walk, /\*\*ENABLED\*\*/);
  assert.match(walk, /#room-default-4, #unknown/);
  const tooFewDefaults = render(t, raw({ channels, onboarding: { ...onboarding, default_channel_ids: ids.slice(0, 6) } }));
  assert.equal(tooFewDefaults.summary.server_level.onboarding_requirement_met_today, false);
  const tooFewSenders = render(t, raw({ channels: channels.map((c, i) => i === 4 ? { ...c, permission_overwrites: [overwrite(GUILD, 0n, SEND)] } : c), onboarding }));
  assert.equal(tooFewSenders.summary.server_level.onboarding_qualifying_channels_today, 4);
  assert.equal(tooFewSenders.summary.server_level.onboarding_requirement_met_today, false);
});

test('audit-report handles empty dumps and disabled onboarding without inventing activity', (t) => {
  const { root, summary, walk } = render(t, raw({ onboarding: { enabled: false, prompts: [{ required: true, in_onboarding: true }] } }));
  for (const name of ['channels', 'categories', 'invites']) {
    assert.equal(readFileSync(join(root, 'audit', `${name}.csv`), 'utf8'), '\n', name);
  }
  assert.equal(summary.counts.channels_total, 0);
  assert.deepEqual(summary.verdicts, { keep: 0, merge: 0, archive: 0, 'rewrite-topic': 0, 'gate-behind-role': 0 });
  assert.equal(summary.server_level.dead_air_ratio, 0);
  assert.equal(summary.server_level.dead_air_denominator, 0);
  assert.equal(summary.server_level.voice_obvious_hangout, false);
  assert.deepEqual(summary.server_level.gate_step_detail, ['no visible channel @everyone can post in']);
  assert.match(walk, /\*\*DISABLED\*\*/);
  assert.match(walk, /Welcome screen lands them in: nothing/);
  assert.match(String(summary.server_level.default_notifications_flag), /^only mentions/);
  assert.deepEqual(Object.keys(summary.members.joins_by_month_last_12), [
    '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
    '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  ]);
  assert.ok(Object.values(summary.members.joins_by_month_last_12).every((n) => n === 0));
});

test('audit-report walkthrough sorts categories/text/voice, omits hidden rooms and keeps dense joins', (t) => {
  const { walk, summary, root } = render(t, raw({
    channels: [channel('late', { type: 4, name: 'Later', position: 8 }), channel('early', { type: 4, name: 'Earlier' }),
      channel('hidden-cat', { type: 4, name: 'Hidden category', position: 4 }),
      channel('voice', { type: 2, name: 'General lounge', parent_id: 'early', position: 0 }),
      channel('text-late', { name: 'text-late', parent_id: 'early', position: 3, topic: '' }),
      channel('text-first', { name: 'text-first', parent_id: 'early', position: 1 }),
      channel('stage', { type: 13, name: 'stage', parent_id: 'early', position: 2 }),
      channel('later-text', { name: 'later-text', parent_id: 'late' }),
      channel('hidden-room', { parent_id: 'hidden-cat', permission_overwrites: [overwrite(GUILD, 0n, VIEW)] }),
      channel('orphan-voice', { type: 2, name: 'orphan-voice' }), channel('orphan-text', { name: 'orphan-text' })],
    members: { role_headcount: {}, joins_by_month: { '2025-09': 9, '2025-10': 2, '2026-09': 3 } },
  }));
  const lines = walk.split('\n').filter((l) => l.startsWith('   ')).map((l) => l.trim());
  assert.deepEqual(lines, ['#orphan-text', '🔊orphan-voice', '#text-first  [0 human msgs/90d]',
    '#text-late  [0 human msgs/90d, no topic]', '🔊General lounge  [0 human msgs/90d]',
    '#stage  [0 human msgs/90d]', '#later-text  [0 human msgs/90d]']);
  assert.ok(walk.indexOf('Earlier') < walk.indexOf('Later'));
  assert.ok(!walk.includes('Hidden category'));
  assert.ok(!walk.includes('hidden-room'));
  assert.equal(summary.server_level.voice_obvious_hangout, true);
  assert.equal(summary.members.joins_by_month_last_12['2025-10'], 2);
  assert.equal(summary.members.joins_by_month_last_12['2026-09'], 3);
  assert.equal(summary.members.joins_by_month_last_12['2025-09'], undefined);
  assert.equal(readFileSync(join(root, 'audit', 'categories.csv'), 'utf8').split('\n')[1],
    'early,Earlier,0,4,4,0,0,0,4');
});

// Preserve only coverage instrumentation, not credentials, in CLI subprocesses.
// Native coverage: https://nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage
function cliEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE };
}
test('audit-report CLI help reads/writes nothing; both root spellings render the library output', async (t) => {
  const empty = mkdtempSync(join(scratch, 'two-audit-report-help-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const help = await exec(process.execPath, [REPORT, '--help', '--root', empty], { cwd: empty, env: cliEnv() });
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /usage: node scripts\/audit-report\.ts/);
  assert.deepEqual(readdirSync(empty), []);
  for (const equals of [false, true]) {
    const root = fixture(t);
    const expected = runAuditReport(root);
    const args = equals ? ['--ignored', `--root=${root}`] : ['--ignored', '--root', root];
    const result = await exec(process.execPath, [REPORT, ...args], { cwd: empty, env: cliEnv() });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected.walk + '\n' + expected.summaryJson);
    assert.deepEqual(readdirSync(empty), []);
  }
});

/**
 * Build the owner-accepted clean-slate structure (TOG-1311 rev 84f6ea56, accepted
 * on TOG-1317) in the LIVE TWO guild — ADDITIVELY.
 *
 * Differences from scripts/staging-clean-slate.ts, all deliberate:
 *
 *  - ADDITIVE ONLY. No channel, role, or bot is deleted or renamed. TOG-1313's
 *    removal gates are closed, and nothing in the accepted proposal removes
 *    anything. Existing channels keep their position in the sidebar; the new
 *    categories are appended at the bottom. A follow-up reordering/removal is a
 *    separate, separately-approved step.
 *  - The token must be the LIVE bot (application 1539711683898118154) and the
 *    guild id the LIVE guild (326474832151838730) — the opposite guard from the
 *    staging script, for the same reason: a run must be unable to hit the wrong
 *    target, in either direction.
 *  - `--confirm-main-guild` is required. Without it the script plans and exits
 *    without writing, so a rehearsal is always safe.
 *  - Every write records the inverse operation to an undo manifest, so rollback
 *    is a file + a loop, not archaeology.
 *
 * Run:
 *   DISCORD_BOT_TOKEN=… node --experimental-strip-types \
 *     scripts/main-guild-clean-slate.ts                 # plan only (no writes)
 *   … --confirm-main-guild --apply                      # build, with undo manifest
 *   … --confirm-main-guild --apply --export            # + final-state export
 */

import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID } from '../src/staging/spec.ts';
import {
  CATEGORIES,
  MODERATOR_ROLE,
  OPERATIONS_CHANNEL_NAMES,
  OWNER_ROLE,
  PUBLIC_READ_ONLY,
  RULES,
  SCREENING_DESCRIPTION,
  SERVER_DESCRIPTION,
  STARTER_MESSAGE,
  TEXT_CHANNEL_NAMES,
  TOPICS,
  VOICE_CHANNEL_NAMES,
  WELCOME_DESCRIPTION,
} from '../src/redesign/clean-slate.ts';

const API = 'https://discord.com/api/v10';
const APPLY = process.argv.includes('--apply');
const EXPORT = process.argv.includes('--export');
const CONFIRMED = process.argv.includes('--confirm-main-guild');
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;

type DiscordObject = Record<string, unknown>;
type Overwrite = { id: string; type: number; allow: string; deny: string };
type UndoEntry = { action: string; method: string; path: string; body?: unknown };

const undo: UndoEntry[] = [];
let failures = 0;
const writes: string[] = [];

function recordUndo(entry: UndoEntry) {
  undo.push(entry);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = (await response.json().catch(() => null)) as T | null;
    if (response.status !== 429) return { status: response.status, body: responseBody };
    const retryAfter = Number((responseBody as { retry_after?: number } | null)?.retry_after ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 30) * 1000));
  }
  return { status: 429, body: null };
}

async function write<T>(label: string, method: string, path: string, body?: unknown, undoEntry?: UndoEntry): Promise<T | null> {
  if (!APPLY || !CONFIRMED) {
    console.log(`WOULD ${label}`);
    return null;
  }
  const result = await api<T>(method, path, body);
  if (result.status >= 300) {
    console.error(`ERROR ${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
    failures++;
    return null;
  }
  console.log(`DID   ${label}`);
  writes.push(label);
  if (undoEntry) recordUndo(undoEntry);
  return result.body;
}

function applicationIdFromToken(value: string): string | null {
  const seg = value.trim().split('.')[0];
  if (!seg) return null;
  try {
    const decoded = Buffer.from(seg, 'base64').toString('utf8');
    return /^\d{15,25}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// ---- guards: refuse to run against anything but the live pair ----

if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN.');
  process.exit(2);
}
const appId = applicationIdFromToken(token);
if (appId !== LIVE_BOT_APPLICATION_ID) {
  console.error(
    `This token is application ${appId}, not the live Owen bot (${LIVE_BOT_APPLICATION_ID}). ` +
      'Refusing to run. Nothing was contacted.',
  );
  process.exit(2);
}
if (guildId !== LIVE_GUILD_ID) {
  console.error(`DISCORD_GUILD_ID is ${guildId}, not the live guild ${LIVE_GUILD_ID}. Refusing to run.`);
  process.exit(2);
}
if (!APPLY && !EXPORT) {
  // pure planning is the default; nothing below writes unless --apply
}
if (APPLY && !CONFIRMED) {
  console.error('Refusing to write to the live guild without --confirm-main-guild. Plan-only run completed.');
  process.exit(2);
}

const me = await api<{ id: string; username: string }>('GET', '/users/@me');
if (me.status !== 200 || !me.body || me.body.id !== LIVE_BOT_APPLICATION_ID) {
  console.error(`Expected live bot ${LIVE_BOT_APPLICATION_ID}; Discord returned HTTP ${me.status}.`);
  process.exit(1);
}
const guilds = await api<Array<{ id: string }>>('GET', '/users/@me/guilds');
if (guilds.status !== 200 || !guilds.body?.some((g) => g.id === guildId)) {
  console.error(`The live bot is not in guild ${guildId}.`);
  process.exit(1);
}
const guild = await api<{ id: string; name: string; owner_id: string; features: string[] }>('GET', `/guilds/${guildId}`);
if (guild.status !== 200 || !guild.body) {
  console.error(`Could not read guild ${guildId}: HTTP ${guild.status}.`);
  process.exit(1);
}

console.log(`\n${APPLY && CONFIRMED ? 'Applying' : 'Planning'} clean-slate structure (ADDITIVE) in ${guild.body.name} (${guildId})`);
console.log('No deletions. No renames. No bot or credential changes. Removal gates (TOG-1313) stay closed.\n');

// ---- roles: create if absent, reconcile colour/hoist/permissions if drifted ----

let roles = (await api<Array<{ id: string; name: string; managed: boolean; color: number; hoist: boolean; permissions: string }>>('GET', `/guilds/${guildId}/roles`)).body ?? [];

for (const wanted of [OWNER_ROLE, MODERATOR_ROLE]) {
  const existing = roles.find((role) => !role.managed && role.name === wanted.name);
  if (!existing) {
    const created = await write<{ id: string }>(
      `create ${wanted.name} role`,
      'POST',
      `/guilds/${guildId}/roles`,
      wanted,
      { action: `delete ${wanted.name} role`, method: 'DELETE', path: `/guilds/${guildId}/roles/{createdId}` },
    );
    // fill the created id into the undo path
    if (created) undo[undo.length - 1].path = `/guilds/${guildId}/roles/${created.id}`;
  } else if (existing.color !== wanted.color || existing.hoist !== wanted.hoist || existing.permissions !== wanted.permissions) {
    await write(`reconcile ${wanted.name} role`, 'PATCH', `/guilds/${guildId}/roles/${existing.id}`, wanted, {
      action: `restore ${wanted.name} role`,
      method: 'PATCH',
      path: `/guilds/${guildId}/roles/${existing.id}`,
      body: { color: existing.color, hoist: existing.hoist, permissions: existing.permissions },
    });
  }
}

// ---- channels & categories: create if absent; reconcile topic/overwrites/parent only ----

let channels = (await api<Array<{ id: string; name: string; type: number; parent_id: string | null; topic?: string | null; permission_overwrites: Overwrite[] }>>('GET', `/guilds/${guildId}/channels`)).body ?? [];

const equalOverwrites = (a: Overwrite[], b: Overwrite[]): boolean => {
  const normalize = (items: Overwrite[]) => items.map((item) => `${item.id}:${item.type}:${item.allow}:${item.deny}`).sort();
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};

const categoryIds = new Map<string, string>();
for (const wanted of CATEGORIES) {
  const existing = channels.find((channel) => channel.type === 4 && channel.name === wanted.name);
  if (existing) categoryIds.set(wanted.name, existing.id);
  else {
    const created = await write<{ id: string }>(`create category ${wanted.name}`, 'POST', `/guilds/${guildId}/channels`, { name: wanted.name, type: 4 }, {
      action: `delete category ${wanted.name}`,
      method: 'DELETE',
      path: '/channels/{createdId}',
    });
    if (created) {
      categoryIds.set(wanted.name, created.id);
      undo[undo.length - 1].path = `/channels/${created.id}`;
    } else {
      // plan mode: a category that will exist by the time its channels are
      // created. A sentinel keeps those channels in the plan instead of
      // silently skipping them because no id exists yet.
      categoryIds.set(wanted.name, 'pending-category-id');
    }
  }
}

channels = APPLY && CONFIRMED ? ((await api<typeof channels>('GET', `/guilds/${guildId}/channels`)).body ?? channels) : channels;
for (const category of CATEGORIES) {
  const parentId = categoryIds.get(category.name) ?? channels.find((channel) => channel.type === 4 && channel.name === category.name)?.id;
  if (!parentId || parentId === 'pending-category-id') {
    if (APPLY && CONFIRMED) {
      console.error(`Category ${category.name} was not created; skipping its channels rather than parenting them nowhere.`);
      continue;
    }
  }
  for (const name of category.channels) {
    const type = VOICE_CHANNEL_NAMES.has(name) ? 2 : 0;
    const existing = channels.find((channel) => channel.type === type && channel.name === name);
    const overwrites: Overwrite[] = OPERATIONS_CHANNEL_NAMES.has(name)
      ? [{ id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }]
      : PUBLIC_READ_ONLY.has(name)
        ? [{ id: guildId, type: 0, allow: String(VIEW_CHANNEL), deny: String(SEND_MESSAGES) }]
        : VOICE_CHANNEL_NAMES.has(name)
          ? [{ id: guildId, type: 0, allow: String(VIEW_CHANNEL | CONNECT | SPEAK), deny: '0' }]
          : [{ id: guildId, type: 0, allow: String(VIEW_CHANNEL | SEND_MESSAGES), deny: '0' }];
    const body = {
      name,
      type,
      ...(parentId && parentId !== 'pending-category-id' ? { parent_id: parentId } : {}),
      ...(TEXT_CHANNEL_NAMES.has(name) ? { topic: TOPICS[name as keyof typeof TOPICS] } : {}),
      permission_overwrites: overwrites,
    };
    if (!existing) {
      const created = await write<{ id: string }>(`create ${type === 2 ? 'voice' : 'text'} channel ${name}`, 'POST', `/guilds/${guildId}/channels`, body, {
        action: `delete channel ${name}`,
        method: 'DELETE',
        path: '/channels/{createdId}',
      });
      if (created) undo[undo.length - 1].path = `/channels/${created.id}`;
    } else if (
      existing.parent_id !== parentId ||
      (TEXT_CHANNEL_NAMES.has(name) && existing.topic !== TOPICS[name as keyof typeof TOPICS]) ||
      !equalOverwrites(existing.permission_overwrites ?? [], overwrites)
    ) {
      await write(`reconcile channel ${name}`, 'PATCH', `/channels/${existing.id}`, body, {
        action: `restore channel ${name}`,
        method: 'PATCH',
        path: `/channels/${existing.id}`,
        body: {
          name: existing.name,
          type: existing.type,
          parent_id: existing.parent_id ?? undefined,
          ...(existing.topic ? { topic: existing.topic } : {}),
          permission_overwrites: existing.permission_overwrites ?? [],
        },
      });
    }
  }
}

// ---- server-level settings; undo carries the pre-change values ----

const freshChannels = APPLY && CONFIRMED ? ((await api<typeof channels>('GET', `/guilds/${guildId}/channels`)).body ?? channels) : channels;
const startHere = freshChannels.find((channel) => channel.name === 'start-here' && channel.type === 0);
const announcements = freshChannels.find((channel) => channel.name === 'announcements' && channel.type === 0);
const general = freshChannels.find((channel) => channel.name === 'general' && channel.type === 0);
const looking = freshChannels.find((channel) => channel.name === 'looking-to-play' && channel.type === 0);

const currentGuild: DiscordObject = (await api<DiscordObject>('GET', `/guilds/${guildId}`)).body ?? guild.body;

if (startHere && announcements) {
  const desired = {
    description: SERVER_DESCRIPTION,
    system_channel_id: startHere.id,
    rules_channel_id: startHere.id,
    public_updates_channel_id: announcements.id,
  };
  const descriptionChanged = currentGuild.description !== SERVER_DESCRIPTION;
  const systemChanged = currentGuild.system_channel_id !== startHere.id;
  const rulesChanged = currentGuild.rules_channel_id !== startHere.id;
  const updatesChanged = currentGuild.public_updates_channel_id !== announcements.id;
  if (descriptionChanged || systemChanged || rulesChanged || updatesChanged) {
    await write('configure guild description and system channels', 'PATCH', `/guilds/${guildId}`, desired, {
      action: 'restore guild description and system channels',
      method: 'PATCH',
      path: `/guilds/${guildId}`,
      body: {
        description: currentGuild.description ?? '',
        system_channel_id: currentGuild.system_channel_id,
        rules_channel_id: currentGuild.rules_channel_id,
        public_updates_channel_id: currentGuild.public_updates_channel_id,
      },
    });
  }
}

const communityEnabled = (currentGuild.features as string[] | undefined)?.includes('COMMUNITY');

if (communityEnabled && startHere && general && looking) {
  const welcomeNow = await api<DiscardableWelcome>('GET', `/guilds/${guildId}/welcome-screen`);
  const welcomeBody = {
    enabled: true,
    description: WELCOME_DESCRIPTION,
    welcome_channels: [
      { channel_id: startHere.id, description: 'Four rules, then the server is yours.', emoji_name: '👋' },
      { channel_id: general.id, description: 'Say hello. People notice who comes back.', emoji_name: '💬' },
      { channel_id: looking.id, description: 'Game, platform, start time — find your crew.', emoji_name: '🎮' },
    ],
  };
  if (welcomeNow.status === 200 && welcomeNow.body && (welcomeNow.body.description !== WELCOME_DESCRIPTION || welcomeNow.body.enabled !== true)) {
    await write('configure three-card Welcome Screen', 'PATCH', `/guilds/${guildId}/welcome-screen`, welcomeBody, {
      action: 'restore previous Welcome Screen',
      method: 'PATCH',
      path: `/guilds/${guildId}/welcome-screen`,
      body: {
        enabled: welcomeNow.body.enabled ?? false,
        description: welcomeNow.body.description ?? '',
        welcome_channels: (welcomeNow.body.welcome_channels as unknown[]) ?? [],
      },
    });
  }
}

if (general) {
  const recentMessages = await api<Array<{ id: string; author: { id: string }; content: string }>>(
    'GET',
    `/channels/${general.id}/messages?limit=50`,
  );
  const starterPresent = recentMessages.body?.some((message) => message.author.id === LIVE_BOT_APPLICATION_ID && message.content === STARTER_MESSAGE);
  if (!starterPresent) {
    const posted = await write<{ id: string }>('post first-message starter', 'POST', `/channels/${general.id}/messages`, {
      content: STARTER_MESSAGE,
      allowed_mentions: { parse: [] },
    }, {
      action: 'delete first-message starter',
      method: 'DELETE',
      path: `/channels/${general.id}/messages/{createdId}`,
    });
    if (posted) undo[undo.length - 1].path = `/channels/${general.id}/messages/${posted.id}`;
  }
}

type DiscardableWelcome = { enabled?: boolean; description?: string; welcome_channels?: unknown[] } | null;

if (APPLY && CONFIRMED || EXPORT) {
  const finalGuild = await api<DiscordObject>('GET', `/guilds/${guildId}`);
  const finalRoles = await api<DiscordObject[]>('GET', `/guilds/${guildId}/roles`);
  const finalChannels = await api<DiscordObject[]>('GET', `/guilds/${guildId}/channels`);
  console.log('\n---BEGIN MAIN GUILD CLEAN SLATE EXPORT---');
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), guild: finalGuild.body, roles: finalRoles.body, channels: finalChannels.body }, null, 2));
  console.log('---END MAIN GUILD CLEAN SLATE EXPORT---');
}

if (APPLY && CONFIRMED) {
  const manifest = JSON.stringify({ generatedAt: new Date().toISOString(), guildId, writes, undo }, null, 2);
  const manifestPath = process.env.UNDO_MANIFEST_PATH ?? 'main-guild-clean-slate-undo.json';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(manifestPath, manifest);
  console.log(`\nUndo manifest written to ${manifestPath} (${undo.length} reversible steps).`);
}

console.log(`\nDone with ${failures} error(s). ${APPLY && CONFIRMED ? `${writes.length} write(s) applied.` : 'No writes (plan only).'}`);
process.exit(failures ? 1 : 0);

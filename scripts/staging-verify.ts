/**
 * Check the staging Discord server against the spec in src/staging/spec.ts.
 *
 *   DISCORD_STAGING_BOT_TOKEN=... DISCORD_STAGING_GUILD_ID=... \
 *     node scripts/staging-verify.ts
 *
 * Run this the moment the staging server exists, before QA writes a single
 * integration test. It answers "is this server the one we agreed on, and can
 * the bot actually do anything in it?" - both of which fail quietly otherwise.
 *
 * The role-position check is first and is the important one. When the bot's
 * own role sits below a role it is asked to grant, Discord returns 403 and
 * nothing in the bot logs an error: the member simply never gets the role and
 * the funnel records a member who "chose not to pick a game". That is a wrong
 * number, not a crash, so it can survive a long time. The fix is one drag in
 * Server Settings > Roles.
 *
 * With one exception, which is now the normal case: a guild OWNER bypasses
 * permission and hierarchy checks entirely, and the staging bot creates - and
 * therefore owns - its own guild (scripts/staging-provision.ts). On that
 * server the position check and the permission-mask check are both
 * meaningless, and running them anyway would report three confident failures
 * on a server that works. Both checks below branch on ownership. The scoped
 * permission set still has to be proved somewhere; on a bot-owned guild it
 * cannot be, and the note says so rather than quietly passing.
 *
 * FAIL = staging cannot support the integration suite. WARN = it works but
 * differs from the spec. Exit code is non-zero only on FAIL.
 *
 * The token is read from the environment and never printed.
 */
import {
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  STAGING_INVITE_PERMISSIONS,
  STAGING_PERMISSIONS,
  STAGING_SERVER_NAME,
  STAGING_TEXT_CHANNELS,
  STAGING_VOICE_CHANNELS,
  checkStagingToken,
  describePermissions,
  stagingGuildId,
  stagingInviteUrl,
} from '../src/staging/spec.ts';
import { evaluateHierarchy, type PartialRole } from '../src/staging/provision.ts';
import {
  findSelfRoleDisallowedPermission,
  findSelfRoleUnsafeChannelGrant,
} from '../src/selfRoles/permissions.ts';
import {
  AUDIT_ACCEPTANCE_KINDS,
  auditAcceptanceSql,
  auditMarkerRowsSql,
  auditRouteForKind,
  evaluateAuditChannels,
  evaluateAuditEvidence,
  evaluateAuditMarkers,
  type AuditAcceptanceRow,
  type AuditMarkerCount,
} from '../src/staging/auditAcceptance.ts';
import { openDb } from '../src/store/db.ts';
import { hasAuditEventIdentity } from '../src/audit/events.ts';

const API = 'https://discord.com/api/v10';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) {
  console.error(
    '\nMissing DISCORD_STAGING_BOT_TOKEN.\n' +
      `  This is the ${STAGING_BOT_APPLICATION_NAME} bot token (application ${STAGING_BOT_APPLICATION_ID}).\n` +
      '  Not the live one. See docs/SECRETS.md.\n',
  );
  process.exit(2);
}

const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) {
  console.error(`\n${tokenCheck.message}\n`);
  process.exit(2);
}

const auditSince = process.env.TWO_AUDIT_ACCEPTANCE_SINCE;
if (!auditSince || !Number.isFinite(Date.parse(auditSince))) {
  console.error(
    '\nMissing or invalid TWO_AUDIT_ACCEPTANCE_SINCE. Set it to the ISO timestamp immediately before ' +
      'driving the controlled audit scenarios so old staging rows cannot produce a false PASS.\n',
  );
  process.exit(2);
}
const stagingDbUrl = process.env.TWO_STAGING_DATABASE_URL?.trim();
if (!stagingDbUrl || !/^postgres(ql)?:\/\//.test(stagingDbUrl)) {
  console.error('\nMissing TWO_STAGING_DATABASE_URL (must be the Postgres staging database).\n');
  process.exit(2);
}
const stagingDbName = new URL(stagingDbUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
if (!/staging|test/i.test(stagingDbName)) {
  console.error(`\nRefusing audit acceptance against non-staging database "${stagingDbName}".\n`);
  process.exit(2);
}

let guildId: string;
try {
  guildId = stagingGuildId();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(2);
}

let fails = 0;
let warns = 0;
const pass = (m: string, d = '') => console.log(`  PASS  ${m}${d && `  ${d}`}`);
let stagingChannels: Array<{ id: string; name: string; type: number; permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }> }> = [];
let acceptedAuditChannelIds = { audit: null, voice: null, moderation: null } as Record<'audit' | 'voice' | 'moderation', string | null>;
const warn = (m: string, d = '') => (warns++, console.log(`  WARN  ${m}${d && `  ${d}`}`));
const fail = (m: string, d = '') => (fails++, console.log(`  FAIL  ${m}${d && `  ${d}`}`));

async function api<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
}

console.log('\nTWO staging server check\n');

// 1. token
const me = await api<{ id: string; username: string }>('/users/@me');
if (me.status !== 200 || !me.body) {
  fail('staging token rejected by Discord', `HTTP ${me.status}`);
  console.log('\nStopping: nothing else can be checked without a valid token.\n');
  process.exit(1);
}
const botId = me.body.id;
pass('staging token valid', `bot "${me.body.username}" (${botId})`);

// 2. the right server
const guild = await api<{ id: string; name: string; owner_id: string }>(`/guilds/${guildId}`);
if (guild.status !== 200 || !guild.body) {
  fail('bot is not in the staging guild', `HTTP ${guild.status} for guild ${guildId}`);
  console.log('\nStopping: run scripts/staging-provision.ts, or re-invite the bot.\n');
  process.exit(1);
}
if (guild.body.name !== STAGING_SERVER_NAME) {
  warn('server name differs from the spec', `"${guild.body.name}" vs "${STAGING_SERVER_NAME}"`);
} else {
  pass('server', `"${guild.body.name}" (${guild.body.id})`);
}
const ownerId = guild.body.owner_id ?? null;
const weOwnIt = ownerId === botId;
if (weOwnIt) {
  pass('the bot owns this guild', 'created by scripts/staging-provision.ts');
}

// 3. roles exist, and the bot can actually hand them out
const roles = await api<PartialRole[]>(`/guilds/${guildId}/roles`);
const hierarchy = roles.body ? evaluateHierarchy({ roles: roles.body, botId, ownerId }) : null;
if (roles.status !== 200 || !roles.body || !hierarchy) {
  fail('cannot read roles', `HTTP ${roles.status}`);
} else {
  const h = hierarchy;

  for (const name of h.missing) fail(`role "${name}" is missing`, 'run scripts/staging-provision.ts --apply');

  if (h.ownerBypass) {
    pass(
      'role hierarchy does not apply',
      'the guild owner bypasses it, so every existing spec role is assignable: ' +
        (h.assignable.join(', ') || 'none created yet'),
    );
  } else {
    if (h.botRoleName) pass('bot role', `"${h.botRoleName}" at position ${h.botPosition}`);
    for (const name of h.assignable) pass(`role "${name}" assignable`, `below the bot at ${h.botPosition}`);
    for (const b of h.blocked) {
      fail(
        `bot cannot assign "${b.name}"`,
        `role is at position ${b.position}, bot at ${h.botPosition}. ` +
          'This fails SILENTLY - Discord returns 403 and nothing logs.',
      );
    }
    if (h.humanFix) console.log(`        ${h.humanFix}`);
    else if (h.repositions.length) console.log('        Fixable: scripts/staging-provision.ts --apply moves them down.');
  }
}

// 4. channels
const channels = await api<
  Array<{
    id: string;
    name: string;
    type: number;
    permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
  }>
>(`/guilds/${guildId}/channels`);
if (channels.status !== 200 || !channels.body) {
  fail('cannot read channels', `HTTP ${channels.status}`);
} else {
  stagingChannels = channels.body;
  const text = new Set(channels.body.filter((c) => c.type === 0).map((c) => c.name));
  const voice = new Set(channels.body.filter((c) => c.type === 2).map((c) => c.name));
  for (const name of STAGING_TEXT_CHANNELS) {
    if (text.has(name)) pass(`#${name} exists`);
    else fail(`#${name} is missing`, 'the integration suite expects it');
  }
  for (const name of STAGING_VOICE_CHANNELS) {
    if (voice.has(name)) pass(`voice "${name}" exists`);
    else
      fail(
        `voice channel "${name}" is missing`,
        'first_voice_session cannot be asserted without a real voice channel',
      );
  }

  const auditChannels = evaluateAuditChannels(channels.body, guildId, botId);
  acceptedAuditChannelIds = auditChannels.channelIds;
  for (const name of auditChannels.missing) fail(`#${name} is missing`, 'the parity suite writes evidence there');
  for (const name of auditChannels.duplicates) {
    fail(`#${name} is duplicated`, 'every matching staff log must be private; reconcile the duplicate explicitly');
  }
  for (const name of auditChannels.memberReadable) {
    fail(`#${name} is member-readable`, 'deny @everyone ViewChannel and remove role/member ViewChannel allows');
  }
  if (
    auditChannels.missing.length === 0 &&
    auditChannels.duplicates.length === 0 &&
    auditChannels.memberReadable.length === 0
  ) {
    pass('staff log privacy', 'all three accepted channels are unique with no member-readable overwrite');
  }
}

// 5. permissions actually held
const self = await api<{ roles: string[] }>(`/guilds/${guildId}/members/${botId}`);
const allRoles = roles.body ?? [];
if (weOwnIt) {
  pass(
    'permissions',
    'owner - Discord grants everything and skips the mask entirely, so there is nothing to check',
  );
  console.log(
    `        Note: the scoped set ${STAGING_PERMISSIONS} therefore cannot be proved on this server.\n` +
      '        That proof belongs on the live invite, not here.',
  );
} else if (self.status === 200 && self.body && allRoles.length) {
  let mask = 0n;
  const held = new Set(self.body.roles);
  for (const r of allRoles) {
    if (held.has(r.id) || r.id === guildId) {
      mask |= BigInt((r as unknown as { permissions: string }).permissions ?? '0');
    }
  }
  const ADMIN = 1n << 3n;
  const { held: have, missing } = describePermissions(mask);
  if (mask & ADMIN) {
    // Administrator IMPLIES every other permission, so the literal bit test
    // below is meaningless here: a role carrying exactly `8` has none of the
    // scoped bits set and can still do all of it. Measured on the real staging
    // guild 2026-09-05 - the bot's only role was permissions `8`,
    // `describePermissions` reported Manage Roles and Manage Events missing,
    // and `POST /guilds/{id}/scheduled-events` returned 200 anyway.
    //
    // Reporting that as a FAIL sent the reader off to re-authorize an invite
    // that would not have changed anything. It is still a WARN, because an
    // Administrator staging bot proves nothing about the live scoped grant -
    // but it is not a missing permission.
    console.log(
      `        Administrator implies the rest, so the scoped set ${STAGING_INVITE_PERMISSIONS} cannot be\n` +
        '        proved on this server. Remove Administrator and re-run before parity acceptance.' +
        (missing.length
          ? `\n        (Not held as explicit bits: ${missing.join(', ')} - implied, not missing.)`
          : ''),
    );
    fail(
      'Administrator permission is held',
      `parity acceptance requires the scoped invite set ${STAGING_INVITE_PERMISSIONS}`,
    );
  } else if (missing.length) {
    // Re-inviting is the fix, not a settings tweak: an invited bot cannot
    // grant itself a bit its invite did not carry.
    fail(
      `missing permissions: ${missing.join(', ')}`,
      `expected the invite set ${STAGING_INVITE_PERMISSIONS}; re-authorize with ` +
        stagingInviteUrl(),
    );
  } else {
    pass('scoped permissions held', have.join(', '));
  }
} else {
  warn('could not resolve the bot\'s effective permissions', `HTTP ${self.status}`);
}

// 6. Audit-log access - anti-nuke cannot identify executors without it.
const audit = await api<unknown>(`/guilds/${guildId}/audit-logs?limit=1`);
if (audit.status === 200) pass('View Audit Log works', 'destructive executors are observable');
else fail('cannot read the Discord audit log', `HTTP ${audit.status}; anti-nuke would refuse to guess an executor`);

// 7. Server Members Intent - the fixture suite is meaningless without it
const app = await api<{ flags?: number }>('/applications/@me');
if (app.status === 200 && app.body) {
  const GUILD_MEMBERS_LIMITED = 1 << 14;
  const GUILD_MEMBERS = 1 << 15;
  const MESSAGE_CONTENT_LIMITED = 1 << 18;
  const MESSAGE_CONTENT = 1 << 19;
  const flags = app.body.flags ?? 0;
  if (flags & (GUILD_MEMBERS_LIMITED | GUILD_MEMBERS)) {
    pass('Server Members Intent is on');
  } else {
    fail(
      'Server Members Intent is OFF',
      'no member_join events will fire. Developer Portal > Bot > Privileged Gateway Intents',
    );
  }
  if (flags & (MESSAGE_CONTENT_LIMITED | MESSAGE_CONTENT)) {
    pass('Message Content Intent is on');
  } else {
    fail(
      'Message Content Intent is OFF',
      'custom automod cannot inspect messages. Developer Portal > Bot > Privileged Gateway Intents',
    );
  }
} else {
  warn('could not read the application flags', `HTTP ${app.status}`);
}

// 7. Hardened role panels. The reaction-role parity suite must not silently
// disappear from the staging proof: an empty catalogue or observational-only
// rollout is a failed deployment because neither proves role mutation parity.
const panelRaw = process.env.TWO_SELF_ROLE_PANELS ?? '';
if (process.env.TWO_SELF_ROLE_DRY_RUN === '1') {
  fail(
    'TWO_SELF_ROLE_DRY_RUN is enabled',
    'reaction-role staging proof requires real role mutations in TWO Staging',
  );
} else {
  pass('self-role mutations are enabled');
}
if (!panelRaw.trim()) {
  fail(
    'TWO_SELF_ROLE_PANELS is empty',
    'reaction-role staging proof requires the configured button, select, and reaction panels',
  );
} else {
  try {
    const { loadSelfRolePanels } = await import('../src/selfRoles/config.ts');
    const panels = loadSelfRolePanels(panelRaw);
    const modes = new Set(panels.map((panel) => panel.mode));
    for (const mode of ['button', 'select', 'reaction'] as const) {
      if (modes.has(mode)) pass(`self-role ${mode} panel is configured`);
      else fail(`self-role ${mode} panel is missing`, 'reaction-role parity requires every picker mode');
    }
    if (panels.length > 1) pass('multiple self-role panels are configured', `${panels.length} panels`);
    else fail('multiple self-role panels are missing', `expected at least 2, found ${panels.length}`);
    if (panels.some((panel) => panel.exclusive)) pass('exclusive self-role panel is configured');
    else fail('exclusive self-role panel is missing', 'reaction-role parity requires exclusive groups');
    if (panels.some((panel) => panel.color && panel.exclusive)) pass('exclusive color-role panel is configured');
    else fail('exclusive color-role panel is missing', 'Color-Chan parity requires an exclusive color group');

    const knownRoles = new Map((roles.body ?? []).map((role) => [role.id, role]));
    for (const panel of panels) {
      const message = await api<{ id: string }>(`/channels/${panel.channelId}/messages/${panel.messageId}`);
      if (message.status === 200 && message.body?.id === panel.messageId) {
        pass(`self-role panel "${panel.id}" message exists`, `${panel.mode} in ${panel.channelId}`);
      } else {
        fail(`self-role panel "${panel.id}" message missing`, `HTTP ${message.status}`);
      }
      for (const option of panel.options) {
        const role = knownRoles.get(option.roleId);
        if (!role) fail(`self-role panel "${panel.id}" role missing`, `${option.label} (${option.roleId})`);
        else {
          const livePermissions = BigInt(role.permissions ?? '0');
          const disallowed = findSelfRoleDisallowedPermission(livePermissions);
          if (disallowed) {
            fail(
              `self-role role "${role.name}" has disallowed permission ${disallowed}`,
              `panel ${panel.id} allows only explicitly approved member-safe permissions`,
            );
          } else if (livePermissions !== BigInt(option.permissions)) {
            fail(
              `self-role role "${role.name}" permission mask changed`,
              `panel ${panel.id} pins ${option.permissions}, Discord reports ${livePermissions}`,
            );
          } else {
            const everyone = knownRoles.get(guildId);
            const unsafeGrant = channels.body && everyone
              ? findSelfRoleUnsafeChannelGrant({
                  guildId,
                  roleId: role.id,
                  everyonePermissions: everyone.permissions ?? '0',
                  rolePermissions: livePermissions,
                  channels: channels.body.map((channel) => ({
                    id: channel.id,
                    name: channel.name,
                    permissionOverwrites: channel.permission_overwrites,
                  })),
                })
              : null;
            if (unsafeGrant) {
              fail(
                `self-role role "${role.name}" has unsafe channel grant ${unsafeGrant.permission}`,
                `channel ${unsafeGrant.channelName ?? unsafeGrant.channelId}`,
              );
            } else if (!weOwnIt && hierarchy && role.position >= (hierarchy.botPosition ?? -1)) {
              fail(`self-role role "${role.name}" is above the bot`, `position ${role.position}`);
            } else {
              pass(`self-role role "${role.name}" assignable`, `panel ${panel.id}`);
            }
          }
        }
      }
    }
  } catch (err) {
    fail('TWO_SELF_ROLE_PANELS is invalid', String(err));
  }
}

// 8. Session goodbye path (TOG-1644/TOG-1654, gap closed by TOG-3314). The
// welcome half already has a staging walkthrough (TOG-1264); the goodbye half
// - registerSessionWelcome's GuildMemberRemove handler in
// src/discord/sessionWelcome.ts - had none. `botCanPost` there resolves the
// first channel in DISCORD_GOODBYE_CHANNEL_IDS the bot can actually post in
// and silently no-ops if none qualify, exactly like the role-hierarchy check
// above: a wrong number, not a crash. This reproduces that same
// resolve-first-postable walk against the real permission grid so a
// misconfigured or over-locked-down goodbye channel fails loudly here instead
// of only in a member's absence going unremarked.
console.log('\nSession goodbye path\n');
const goodbyeChannelIds = (process.env.DISCORD_GOODBYE_CHANNEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!goodbyeChannelIds.length) {
  fail('DISCORD_GOODBYE_CHANNEL_IDS is empty', 'session_goodbye_dry_run/session_goodbye_posted can never fire');
} else {
  const everyoneId = guildId;
  const botRoleIds = new Set((self.body as { roles?: string[] } | null)?.roles ?? []);
  const channelById = new Map(stagingChannels.map((c) => [c.id, c]));
  const VIEW_CHANNEL = 1n << 10n;
  const SEND_MESSAGES = 1n << 11n;
  let resolved: { id: string; name: string } | null = null;
  for (const id of goodbyeChannelIds) {
    const channel = channelById.get(id);
    if (!channel) {
      fail(`goodbye channel ${id} does not exist`, 'DISCORD_GOODBYE_CHANNEL_IDS names a channel not in the guild');
      continue;
    }
    if (weOwnIt) {
      // Same bypass as section 5: an owner-bot skips overwrite resolution
      // entirely, so there is nothing to compute here.
      resolved = resolved ?? { id: channel.id, name: channel.name };
      continue;
    }
    const overwrites = channel.permission_overwrites ?? [];
    const byKey = new Map(overwrites.map((o) => [`${o.type}:${o.id}`, o]));
    let perms = 0n;
    for (const r of allRoles) {
      if (botRoleIds.has(r.id) || r.id === guildId) {
        perms |= BigInt((r as unknown as { permissions: string }).permissions ?? '0');
      }
    }
    const everyoneOw = byKey.get(`0:${everyoneId}`);
    if (everyoneOw) perms = (perms & ~BigInt(everyoneOw.deny)) | BigInt(everyoneOw.allow);
    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const r of allRoles) {
      if (!botRoleIds.has(r.id)) continue;
      const ow = byKey.get(`0:${r.id}`);
      if (ow) {
        roleAllow |= BigInt(ow.allow);
        roleDeny |= BigInt(ow.deny);
      }
    }
    perms = (perms & ~roleDeny) | roleAllow;
    const memberOw = byKey.get(`1:${botId}`);
    if (memberOw) perms = (perms & ~BigInt(memberOw.deny)) | BigInt(memberOw.allow);
    if ((perms & (VIEW_CHANNEL | SEND_MESSAGES)) === (VIEW_CHANNEL | SEND_MESSAGES)) {
      resolved = resolved ?? { id: channel.id, name: channel.name };
    }
  }
  if (resolved) {
    pass(
      `goodbye resolves to #${resolved.name}`,
      `first postable channel in [${goodbyeChannelIds.join(', ')}], matching botCanPost's own walk order`,
    );
  } else {
    fail(
      'no goodbye channel is postable',
      `checked [${goodbyeChannelIds.join(', ')}] - GuildMemberRemove will return early and post nothing`,
    );
  }

  // Evidence half: proves an actual send, not just the precondition above.
  // Opt-in via TWO_GOODBYE_VERIFY_SINCE because it requires a real member to
  // have left staging since that timestamp - staging-verify runs without a
  // fresh departure to check must not FAIL on this, only report it as
  // unproven.
  const goodbyeSince = process.env.TWO_GOODBYE_VERIFY_SINCE?.trim();
  if (!goodbyeSince) {
    console.log(
      '        Not checked this run: set TWO_GOODBYE_VERIFY_SINCE=<ISO timestamp> to a moment ' +
        'immediately before a real member leaves/is kicked from TWO Staging, then re-run to confirm ' +
        'the actual send (not just that the channel is postable).',
    );
  } else if (!Number.isFinite(Date.parse(goodbyeSince))) {
    fail('TWO_GOODBYE_VERIFY_SINCE is not a valid ISO timestamp', goodbyeSince);
  } else if (!resolved) {
    fail('cannot verify a goodbye send', 'no channel resolved above to read messages from');
  } else {
    const query = new URLSearchParams({ limit: '50' });
    const history = await api<Array<{ id: string; content: string; timestamp: string; author: { id: string; bot?: boolean } }>>(
      `/channels/${resolved.id}/messages?${query}`,
    );
    if (history.status !== 200 || !history.body) {
      fail('could not read the goodbye channel history', `HTTP ${history.status}`);
    } else {
      const sent = history.body.find(
        (m) =>
          m.author.id === botId &&
          Date.parse(m.timestamp) >= Date.parse(goodbyeSince) &&
          /left the server/.test(m.content) &&
          /stay on the books/.test(m.content) &&
          !/<@/.test(m.content),
      );
      if (sent) {
        pass(
          'a real goodbye message was posted',
          `message ${sent.id} in #${resolved.name} at ${sent.timestamp}, pings nobody`,
        );
      } else {
        fail(
          'no goodbye message found since TWO_GOODBYE_VERIFY_SINCE',
          `checked #${resolved.name} for a bot message matching goodbyeText() after ${goodbyeSince}`,
        );
      }
    }
  }
}

async function discordMarkerMessageIds(channelId: string, entryId: string, since: string): Promise<string[]> {
  const matches: string[] = [];
  let before = '';
  while (true) {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const result = await api<Array<{ id: string; content: string; timestamp: string; author: { id: string } }>>(
      `/channels/${channelId}/messages?${query}`,
    );
    if (result.status !== 200 || !result.body) throw new Error(`Discord marker fetch failed for channel ${channelId}: HTTP ${result.status}`);
    for (const message of result.body) {
      if (Date.parse(message.timestamp) < Date.parse(since)) return matches;
      if (message.author.id === botId && hasAuditEventIdentity(message.content, entryId)) matches.push(message.id);
    }
    if (result.body.length < 100) return matches;
    before = result.body.at(-1)?.id ?? '';
    if (!before) return matches;
  }
}

// 7. Reconcile the controlled live scenarios against the staging database.
// The explicit lower bound prevents yesterday's evidence hiding a dead gateway
// listener today.
console.log('\nAudit parity acceptance\n');
let auditDb;
try {
  auditDb = await openDb(stagingDbUrl, { skipMigrations: true, applicationName: 'two-bot-staging-verify' });
  const acceptedSinkIds = Object.values(acceptedAuditChannelIds).filter((id): id is string => Boolean(id));
  const rows = await auditDb.prepare(auditAcceptanceSql(guildId, auditSince, acceptedSinkIds)).all<AuditAcceptanceRow>();
  const evidence = evaluateAuditEvidence(rows);
  for (const kind of AUDIT_ACCEPTANCE_KINDS) {
    if (evidence.missing.includes(kind)) fail(`${kind} durable evidence is missing`, `since ${auditSince}`);
    else if (evidence.duplicates.includes(kind)) fail(`${kind} contains duplicate entry ids`, 'rows must equal distinct entry_id count');
    else if (evidence.pendingDeliveries.includes(kind)) fail(`${kind} has an incomplete audit mirror`, 'delivery_state must be delivered');
    else pass(`${kind} evidence`, `durable and delivered since ${auditSince}`);
  }
  if (evidence.missingSinkTamper) {
    fail('audit-sink tamper evidence is missing', 'delete or edit one controlled mirror after the lower bound');
  } else {
    pass('audit-sink tamper evidence', 'durable with delivery_state=none and no recursive mirror');
  }
  if (evidence.missingModerationSuccess) {
    fail(
      'successful moderation audit evidence is missing',
      'drive a Discord-mutating action such as moderation.slowmode; moderation.warn or a refusal cannot certify parity',
    );
  } else {
    pass(
      'successful moderation audit evidence',
      'Discord-mutating moderation_service outcome is correlated to a bot-executed Discord audit entry',
    );
  }

  const markerRows = await auditDb.prepare(auditMarkerRowsSql(guildId, auditSince)).all<{
    entry_id: string; event_kind: (typeof AUDIT_ACCEPTANCE_KINDS)[number];
    mirror_channel_id: string; mirror_message_id: string | null;
  }>();
  const channelById = new Map(stagingChannels.map((channel) => [channel.id, channel]));
  const markerCounts: AuditMarkerCount[] = [];
  for (const row of markerRows) {
    const expectedChannelId = acceptedAuditChannelIds[auditRouteForKind(row.event_kind)];
    const channel = row.mirror_channel_id === expectedChannelId
      ? channelById.get(row.mirror_channel_id)
      : undefined;
    markerCounts.push({
      entryId: row.entry_id,
      eventKind: row.event_kind,
      mirrorMessageId: row.mirror_message_id,
      channelId: row.mirror_channel_id,
      expectedChannelId,
      messageIds: channel
        ? await discordMarkerMessageIds(row.mirror_channel_id, row.entry_id, auditSince)
        : [],
    });
  }
  const markers = evaluateAuditMarkers(markerCounts);
  for (const entryId of markers.channelMismatches) fail('audit mirror used an unapproved sink channel', entryId);
  for (const entryId of markers.missing) fail('audit mirror marker is missing', entryId);
  for (const entryId of markers.duplicates) fail('audit mirror marker is duplicated', entryId);
  for (const entryId of markers.messageIdMismatches) fail('audit mirror message id does not match Discord', entryId);
  if (!markers.channelMismatches.length && !markers.missing.length && !markers.duplicates.length && !markers.messageIdMismatches.length) {
    pass('Discord audit mirror reconciliation', `${markerCounts.length} durable rows each have exactly one matching marker in its private sink`);
  }
} catch (err) {
  fail('audit evidence query failed', String(err));
} finally {
  await auditDb?.close();
}

console.log('\nRequired controlled scenarios:');
console.log('  - repeat one event and prove entry_id dedupe keeps one durable row and one mirror');
console.log('  - remove Send Messages from one log channel and prove the durable row survives, then retries');
console.log('  - attempt a protected/higher-role moderation target and prove refusal is mirrored');
console.log('  - run moderation.slowmode with a reversible value and prove the bot-executed Discord audit entry is correlated');
console.log('  - inspect payloads for absence of message content, usernames, nicknames and mentions');

console.log(`\n${fails} fail, ${warns} warn\n`);
process.exit(fails ? 1 : 0);

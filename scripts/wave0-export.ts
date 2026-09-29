/**
 * Wave 0 pre-flight for the TOG-34 server redesign. READ-ONLY.
 *
 *   DISCORD_TOKEN=... node scripts/wave0-export.ts
 *   DISCORD_TOKEN=... node scripts/wave0-export.ts --out data/wave0
 *
 * Produces the two exports that gate Wave 6, plus the voice baseline and the
 * drift check, in one pass. Wave 6 deletes 159 roles; a recreated role has a
 * new id and no members, so the holder lists below are the only record that
 * will exist afterwards. `server-redesign` rev 6 §4.4, §7 Wave 0, §9.
 *
 * THREE RULES THIS FILE ENFORCES BY CONSTRUCTION, not by convention:
 *
 * 1. READ-ONLY. It talks to Discord only through `DiscordRest.get`, which
 *    hardcodes GET and has no post/patch/delete sibling to reach for. There is
 *    no code path here that can change the server. Same guarantee, and the same
 *    reasoning, as scripts/audit-collect.ts.
 *
 * 2. NO MESSAGE CONTENT. #voice-log is read for embed *shape* only, via the
 *    parsers in src/backfill/parse.ts. A message body is never stored, printed
 *    or logged. docs/PRIVACY.md.
 *
 * 3. NOTHING WRITTEN INSIDE THE REPO. Output goes to data/, which .gitignore
 *    excludes. These CSVs are the one artefact in this project that names
 *    individual members, and they must not reach GitHub. PRIVACY.md permits
 *    storing user IDs; it does not permit publishing them.
 *
 * WHAT THIS SCRIPT CANNOT DO — read this before trusting a green run.
 * Wave 0.1 asks us to confirm `TWO-BOT` is whitelisted in Wick's anti-nuke
 * config. That configuration lives inside Wick, not in Discord, and Discord's
 * API does not expose another application's private settings. No script can
 * check it. Section 1 of the report below prints the evidence the API *can*
 * give and then says, in as many words, that the whitelist itself is unverified
 * and needs a human in the Wick dashboard. It is never reported as passing.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordRest, scanChannel } from '../src/discord/rest.ts';
import type { RawMessage } from '../src/discord/rest.ts';
import { parseVoiceMessage, dateToSnowflake } from '../src/backfill/parse.ts';
import { GUILD_ID } from '../src/onboarding/catalog.ts';

const TOKEN = process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID ?? GUILD_ID;
if (!TOKEN) {
  console.error(
    'need DISCORD_TOKEN (or DISCORD_BOT_TOKEN).\n\n' +
      'This is a Paperclip secret held by the Founding Engineer (TOG-13, TOG-33).\n' +
      'Reading the member list also needs the Server Members privileged intent,\n' +
      'which scripts/preflight.ts checks. Run that first if this is a new token.',
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const outDir = argv[argv.indexOf('--out') + 1] && argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'data/wave0';
// TOG-8963 removed the snapshot from HEAD (member user IDs); it lives on in
// history. Point at a local copy, or leave unset to skip the drift check.
const AUDIT = process.env.WAVE0_AUDIT_PATH;
const VOICE_LOG_CHANNEL = process.env.WAVE0_VOICE_LOG_ID ?? '1139711709980925962'; // #voice-log
const VOICE_DAYS = 90;

/**
 * The roles Wave 0 must enumerate, with the holder count the 2026-08-19 audit
 * recorded. The counts are assertions, not decoration: if live disagrees with
 * the snapshot, somebody changed the server since the audit and §7 Wave 0.4
 * says find out why before starting.
 */
const GAME_ROLES: Record<string, { name: string; expected: number }> = {
  '1051272877871222915': { name: 'Shooter Games', expected: 27 },
  '1179233034713702511': { name: 'Survival Games', expected: 11 },
  '1119666971584237679': { name: 'Horror Games', expected: 6 },
};

/** §2 of the TOG-306 execution gate. SySOp is KEEP; the other three are deleted in Wave 6. */
const BANKICK_ROLES: Record<string, { name: string; expected: number; wave6: string }> = {
  '1078757544169848933': { name: 'Officer', expected: 3, wave6: 'DELETE' },
  '1078757266469175386': { name: 'Game Master', expected: 1, wave6: 'DELETE' },
  '1087192823767515219': { name: 'Staff', expected: 6, wave6: 'DELETE' },
  '508654771276873729': { name: 'SySOp', expected: 1, wave6: 'KEEP (renamed Owner)' },
};

/** Test-only. test/e2e.wave0.test.ts points this at a stub so the script can be run for real. */
const API_BASE = process.env.WAVE0_API_BASE;
const rest = new DiscordRest(API_BASE ? { token: TOKEN, base: API_BASE, minIntervalMs: 0 } : { token: TOKEN });
mkdirSync(outDir, { recursive: true });

const report: string[] = [];
const drift: string[] = [];
const say = (s = '') => {
  console.log(s);
  report.push(s);
};

/** RawMember in rest.ts does not declare `roles`; Wave 0 is entirely about roles. */
interface MemberWithRoles {
  user?: { id: string; bot?: boolean; username?: string };
  nick?: string | null;
  joined_at?: string | null;
  roles?: string[];
}

/** rest.ts's fetchAllMembers drops `roles`, so page it here with the field kept. */
async function fetchMembersWithRoles(): Promise<MemberWithRoles[]> {
  const out: MemberWithRoles[] = [];
  let after = '0';
  for (;;) {
    const batch = await rest.get<MemberWithRoles[]>(
      `/guilds/${GUILD}/members?limit=1000&after=${after}`,
    );
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    const last = batch[batch.length - 1]?.user?.id;
    if (!last || batch.length < 1000) break;
    after = last;
  }
  return out;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const writeCsv = (file: string, header: string[], rows: string[][]) => {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  writeFileSync(join(outDir, file), body + '\n');
  return rows.length;
};

say('');
say('TWO Wave 0 pre-flight — read-only. No change is issued to the server.');
say(`guild ${GUILD}   audit base ${AUDIT ?? '(none — drift check skipped)'}`);
say('');

// ---------------------------------------------------------------------------
// 0. The member list, once. Everything below is a filter over it.
// ---------------------------------------------------------------------------
const members = await fetchMembersWithRoles();
if (members.length === 0) {
  console.error(
    '\nFATAL: the member list came back empty.\n' +
      'GET /guilds/{id}/members returns 403 unless the Server Members privileged\n' +
      'intent is enabled for this bot in the Discord developer portal. An empty\n' +
      'list here means "we could not read", not "the server is empty" — writing\n' +
      'zero-row CSVs from it would destroy the very data Wave 6 cannot recover.\n' +
      'Run scripts/preflight.ts, fix the intent, then re-run.',
  );
  process.exit(3);
}
const humans = members.filter((m) => !m.user?.bot);
say(`Member list: ${members.length} total, ${humans.length} human, ${members.length - humans.length} bots.`);
say('');

const holdersOf = (roleId: string) => members.filter((m) => (m.roles ?? []).includes(roleId));

// ---------------------------------------------------------------------------
// 1. Wick anti-nuke (§7 Wave 0.1) — reported, never asserted.
// ---------------------------------------------------------------------------
say('## 1. Wick anti-nuke whitelist');
say('');
interface RawRole { id: string; name: string; managed?: boolean; permissions?: string; tags?: { bot_id?: string } }
const liveRoles = (await rest.get<RawRole[]>(`/guilds/${GUILD}/roles`)) ?? [];
const wickRole = liveRoles.find((r) => /^wick$/i.test(r.name));

const wickMember = members.find((m) => /^wick$/i.test(m.user?.username ?? ''));
const ourMember = members.find((m) => /^(two-?bot|owen)$/i.test(m.user?.username ?? ''));

say(`- Wick role present: ${wickRole ? `yes (${wickRole.id})` : 'NOT FOUND'}`);
say(`- Wick member present: ${wickMember ? `yes (${wickMember.user?.id})` : 'NOT FOUND'}`);
say(`- Our bot present: ${ourMember ? `yes, ${ourMember.user?.username} (${ourMember.user?.id})` : 'NOT FOUND'}`);
say(`- Our bot's roles: ${(ourMember?.roles ?? []).join(' ') || '(none)'}`);
say('');
say('**UNVERIFIED — and it cannot be verified from here.** Wick\'s anti-nuke');
say('whitelist is internal to Wick. Discord exposes no endpoint for another');
say('application\'s configuration, so the four lines above are the *most* the API');
say('can say and none of them answer the actual question. Someone with dashboard');
say('access must open Wick > anti-nuke > whitelist and confirm our bot is on it');
say('BEFORE Wave 1. If it is armed and we are not whitelisted, the likely outcome');
say('is Wick banning our own bot midway through Wave 5 or 6 while behaving');
say('exactly as configured.');
say('');

// ---------------------------------------------------------------------------
// 2 + 3. The two holder exports. These are the point of Wave 0.
// ---------------------------------------------------------------------------
const holderRows: string[][] = [];
const checkGroup = (
  title: string,
  spec: Record<string, { name: string; expected: number }>,
  file: string,
  extra?: Record<string, { wave6: string }>,
) => {
  say(`## ${title}`);
  say('');
  const rows: string[][] = [];
  for (const [roleId, { name, expected }] of Object.entries(spec)) {
    const live = liveRoles.find((r) => r.id === roleId);
    const hs = holdersOf(roleId);
    const mark = hs.length === expected ? 'ok' : `DRIFT (audit said ${expected})`;
    if (hs.length !== expected) {
      drift.push(`${name} (${roleId}): audit ${expected} holders, live ${hs.length}`);
    }
    if (!live) drift.push(`${name} (${roleId}): role no longer exists on the server`);
    say(`- ${name} (${roleId}): ${hs.length} holders — ${mark}${live ? '' : '  [ROLE MISSING]'}`);
    for (const m of hs) {
      const row = [
        roleId,
        name,
        m.user?.id ?? '',
        m.user?.username ?? '',
        m.nick ?? '',
        m.joined_at ?? '',
      ];
      if (extra) row.push(extra[roleId]?.wave6 ?? '');
      rows.push(row);
      holderRows.push([name, m.user?.id ?? '']);
    }
  }
  const header = ['role_id', 'role_name', 'user_id', 'username', 'nick', 'joined_at'];
  if (extra) header.push('wave6_action');
  const n = writeCsv(file, header, rows);
  say('');
  say(`  -> ${join(outDir, file)} (${n} rows)`);
  say('');
};

checkGroup('2. Game-role holders (§4.4 — unrecoverable after Wave 6)', GAME_ROLES, 'game-role-holders.csv');
checkGroup(
  '3. Ban/kick holders (execution-gate §2 — must be told before Wave 6)',
  BANKICK_ROLES,
  'bankick-holders.csv',
  BANKICK_ROLES,
);

/**
 * The execution gate could only ever say "10 holder-slots is 5-10 distinct
 * humans" because no artefact on disk had per-member roles. This run does. The
 * ambiguity that document called permanent is resolved here, exactly once.
 */
const banKickIds = new Set<string>();
for (const roleId of Object.keys(BANKICK_ROLES)) {
  for (const m of holdersOf(roleId)) if (m.user?.id) banKickIds.add(m.user.id);
}
const slots = Object.keys(BANKICK_ROLES).reduce((n, r) => n + holdersOf(r).length, 0);
say('### Holder-slots vs distinct people');
say('');
say(`- ${slots} holder-slots across the four roles`);
say(`- **${banKickIds.size} distinct humans** hold at least one of them`);
say('');
say('The TOG-306 execution gate stated a range of 5-10 people and called it');
say('permanent, because every artefact on disk stored holdings rather than');
say('people. This run reads the live member list, so the number above is exact.');
say('Deduplicating is what turns "notify ten holder-slots" into a real list of');
say('people to talk to before Wave 6.');
say('');

// ---------------------------------------------------------------------------
// 4. Voice baseline (§7 Wave 0.3, §9).
// ---------------------------------------------------------------------------
say('## 4. Voice baseline — unique humans per week, last 90 days');
say('');
const since = new Date(Date.now() - VOICE_DAYS * 86_400_000);
const stopBefore = since.toISOString();
let voiceRows: string[][] = [];
const scan = await scanChannel(rest, VOICE_LOG_CHANNEL, { maxPages: 400, stopBefore });
if (scan.messages.length === 0) {
  say(`- #voice-log (${VOICE_LOG_CHANNEL}) returned no messages.`);
  say('  Either the channel id moved or the bot cannot read it. NOT a zero baseline —');
  say('  an unread channel and an empty one are different facts. Treat as UNKNOWN.');
  say('');
  drift.push('voice baseline: #voice-log unreadable or empty; baseline not established');
} else {
  const perWeek = new Map<string, Set<string>>();
  const botAuthors = new Set<string>();
  let parsed = 0;
  for (const msg of scan.messages as RawMessage[]) {
    if (msg.timestamp < stopBefore) continue;
    const v = parseVoiceMessage(msg);
    if (!v) continue;
    parsed++;
    if (msg.author?.bot) botAuthors.add(msg.author.id);
    // ISO week bucket, Monday-anchored.
    const d = new Date(v.occurredAt);
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!perWeek.has(key)) perWeek.set(key, new Set());
    perWeek.get(key)!.add(v.memberId);
  }
  const weeks = [...perWeek.entries()].sort(([a], [b]) => a.localeCompare(b));
  const allHumans = new Set<string>();
  for (const [, s] of weeks) for (const id of s) allHumans.add(id);
  say(`- scanned ${scan.messages.length} messages back to ${scan.scannedBackTo?.slice(0, 10)}` +
      `${scan.truncated ? ' (TRUNCATED at the page cap)' : ''}`);
  say(`- ${parsed} parsed as voice events across ${weeks.length} weeks`);
  say(`- ${allHumans.size} distinct members appeared in voice at least once in ${VOICE_DAYS}d`);
  say('');
  for (const [wk, s] of weeks) say(`    ${wk}  ${String(s.size).padStart(3)} unique`);
  say('');
  if (scan.truncated) {
    drift.push('voice baseline: scan hit the page cap; the 90d window is incomplete');
  }
  voiceRows = weeks.map(([wk, s]) => [wk, String(s.size)]);
  const n = writeCsv('voice-baseline.csv', ['week_starting', 'unique_members_in_voice'], voiceRows);
  say(`  -> ${join(outDir, 'voice-baseline.csv')} (${n} rows)`);
  say('');
}

// ---------------------------------------------------------------------------
// 5. Drift: live vs the 2026-08-19 snapshot (§7 Wave 0.4).
// ---------------------------------------------------------------------------
say('## 5. Drift against ' + (AUDIT ?? '(no snapshot — skipped)'));
say('');
if (!AUDIT || !existsSync(AUDIT)) {
  say(`- ${AUDIT ?? 'no snapshot configured'}; skipped. This is the diff base §7 Wave 0.4 requires.`);
  drift.push(`audit snapshot ${AUDIT ?? 'unconfigured'} — no drift check performed`);
} else {
  interface AuditRole { role_id: string; name: string; members_holding: number; dangerous_permissions?: string }
  interface Audit { roles: AuditRole[]; channels: { id: string; name: string }[]; categories: { id: string; name: string }[] }
  const audit = JSON.parse(readFileSync(AUDIT, 'utf8')) as Audit;

  const liveIds = new Set(liveRoles.map((r) => r.id));
  const auditIds = new Set(audit.roles.map((r) => r.role_id));
  const added = liveRoles.filter((r) => !auditIds.has(r.id));
  const removed = audit.roles.filter((r) => !liveIds.has(r.role_id));
  const renamed = audit.roles
    .map((a) => ({ a, l: liveRoles.find((r) => r.id === a.role_id) }))
    .filter((p) => p.l && p.l.name !== p.a.name);

  say(`- roles: audit ${audit.roles.length}, live ${liveRoles.length}`);
  say(`- added since audit: ${added.length}${added.length ? ' — ' + added.map((r) => `${r.name} (${r.id})`).join(', ') : ''}`);
  say(`- removed since audit: ${removed.length}${removed.length ? ' — ' + removed.map((r) => `${r.name} (${r.role_id})`).join(', ') : ''}`);
  say(`- renamed since audit: ${renamed.length}${renamed.length ? ' — ' + renamed.map((p) => `${p.a.name} -> ${p.l!.name}`).join(', ') : ''}`);

  const liveChannels = (await rest.get<{ id: string; name: string }[]>(`/guilds/${GUILD}/channels`)) ?? [];
  const auditChannelIds = new Set([...audit.channels.map((c) => c.id), ...audit.categories.map((c) => c.id)]);
  const chAdded = liveChannels.filter((c) => !auditChannelIds.has(c.id));
  const chRemoved = [...audit.channels, ...audit.categories].filter(
    (c) => !liveChannels.some((l) => l.id === c.id),
  );
  say(`- channels+categories: audit ${auditChannelIds.size}, live ${liveChannels.length}`);
  say(`- added: ${chAdded.length}${chAdded.length ? ' — ' + chAdded.map((c) => `${c.name} (${c.id})`).join(', ') : ''}`);
  say(`- removed: ${chRemoved.length}${chRemoved.length ? ' — ' + chRemoved.map((c) => `${c.name} (${c.id})`).join(', ') : ''}`);

  for (const label of [...added.map((r) => `role added: ${r.name} (${r.id})`),
                       ...removed.map((r) => `role removed: ${r.name} (${r.role_id})`),
                       ...chRemoved.map((c) => `channel removed: ${c.name} (${c.id})`)]) {
    drift.push(label);
  }

  // The 14 ADMINISTRATOR|MANAGE_CHANNELS roles §7 Wave 0.4 calls out by count.
  const ADMIN = 1n << 3n;
  const MANAGE_CHANNELS = 1n << 4n;
  const powerful = liveRoles.filter((r) => {
    const p = BigInt(r.permissions ?? '0');
    return (p & ADMIN) !== 0n || (p & MANAGE_CHANNELS) !== 0n;
  });
  say(`- roles holding ADMINISTRATOR or MANAGE_CHANNELS: ${powerful.length} (audit-era expectation: 14)`);
  if (powerful.length !== 14) drift.push(`admin/manage-channels role count is ${powerful.length}, audit-era expectation was 14`);
  say('');
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
say('## Verdict');
say('');
if (drift.length === 0) {
  say('No drift against the snapshot, and both holder CSVs are written.');
} else {
  say(`${drift.length} thing(s) to explain before Wave 1 — §7 stop rule:`);
  say('');
  for (const d of drift) say(`  - ${d}`);
}
say('');
say('Still open regardless of the above: the Wick whitelist in §1 is UNVERIFIED');
say('and no script can close it. Wave 1 must not start until a human has.');
say('');

writeFileSync(join(outDir, 'wave0-report.md'), report.join('\n') + '\n');
console.log(`report -> ${join(outDir, 'wave0-report.md')}`);
console.log(`discord requests: ${rest.requests}`);
process.exit(drift.length === 0 ? 0 : 1);

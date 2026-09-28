import {
  checkStagingToken,
  TWO_STAGING_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_SERVER_NAME,
} from '../src/staging/spec.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Library: announcements proof config/validators. Importing this file never
// reads argv and never exits; the block below only runs on direct invocation.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log('usage: node scripts/staging-announcements-state.ts --help');
  console.log('');
  console.log('Announcements proof config and validators (library, no direct invocation).');
  console.log('Imported by scripts/staging-announcements-proof.ts and scripts/staging-announcements-verify.ts.');
  console.log('No token, no database, no side effects on --help.');
  process.exit(process.argv.includes('--help') ? 0 : 2);
}

export interface ProofCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface AnnouncementsProof {
  version: 1;
  runId: string;
  schema: string;
  guildId: string;
  applicationId: string;
  head: string;
  startedAt: string;
  finishedAt: string;
  channelId: string;
  deniedChannelId: string | null;
  eventId: string | null;
  messageIds: string[];
  checks: ProofCheck[];
}

export function proofSchema(runId: string): string {
  if (!/^[a-f0-9]{24}$/.test(runId)) throw new Error('Invalid announcements proof run id.');
  return `tog3845_ann_${runId}`;
}

/** No generic bot token/DB fallback, routing options, or caller-selected guild. */
export function announcementsProofConfig(env: NodeJS.ProcessEnv): { token: string; dbUrl: string } {
  const token = env.DISCORD_STAGING_BOT_TOKEN ?? '';
  if (!checkStagingToken(token).ok) throw new Error('An identified Owen QA Test token is required.');
  if (env.DISCORD_STAGING_GUILD_ID && env.DISCORD_STAGING_GUILD_ID !== TWO_STAGING_GUILD_ID) {
    throw new Error('Only the fixed TWO Staging guild is allowed.');
  }
  let db: URL;
  try { db = new URL(env.TWO_STAGING_DATABASE_URL ?? ''); }
  catch { throw new Error('An explicit TWO_STAGING_DATABASE_URL is required.'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.pathname !== '/two_bot_staging' || db.search || db.hash) {
    throw new Error('Only two_bot_staging without connection-routing options is allowed.');
  }
  return { token, dbUrl: db.toString() };
}

export function assertProofIdentity(applicationId: string, guild: { id: string; name: string }): void {
  if (applicationId !== STAGING_BOT_APPLICATION_ID || guild.id !== TWO_STAGING_GUILD_ID || guild.name !== STAGING_SERVER_NAME) {
    throw new Error('Remote application/guild identity does not match TWO Staging.');
  }
}

export function ownsProofMessage(message: { author?: { id?: string }; content?: string }, marker: string): boolean {
  return message.author?.id === STAGING_BOT_APPLICATION_ID && (message.content ?? '').includes(marker);
}

/** Validate before interpolating a schema or letting an evidence file select REST targets. */
export function parseAnnouncementsProof(value: unknown): AnnouncementsProof {
  const p = value as AnnouncementsProof | null;
  const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{17,20}$/.test(v);
  if (!p || p.version !== 1 || typeof p.runId !== 'string' || p.schema !== proofSchema(p.runId)
    || p.guildId !== TWO_STAGING_GUILD_ID || p.applicationId !== STAGING_BOT_APPLICATION_ID
    || !/^[a-f0-9]{40}$/.test(p.head) || !Number.isFinite(Date.parse(p.startedAt))
    || !Number.isFinite(Date.parse(p.finishedAt)) || !snowflake(p.channelId) || !snowflake(p.eventId)
    || !snowflake(p.deniedChannelId) || !Array.isArray(p.messageIds) || !p.messageIds.length
    || !p.messageIds.every(snowflake) || !Array.isArray(p.checks) || !p.checks.length
    || !p.checks.every(c => typeof c.name === 'string' && typeof c.pass === 'boolean' && typeof c.detail === 'string')) {
    throw new Error('Invalid or incomplete announcements proof report.');
  }
  return p;
}

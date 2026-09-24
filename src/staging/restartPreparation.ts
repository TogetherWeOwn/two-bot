/** Preparation only: no process launch, network access or database connection.
 * These checks do not establish review/merge authorization, installed dependency
 * integrity, exclusive bot ownership, disposable storage ownership or transport
 * isolation. Actual staging execution remains prohibited without those gates.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadOnboardingRotaConfig } from '../analytics/onboardingRotaConfig.ts';
import { assertStagingRestartPreflight, parseSyntheticStagingActorIds } from './restartContainment.ts';
import { TWO_STAGING_GUILD_ID } from './spec.ts';

export type RestartMode = 'notice-on' | 'notice-off' | 'master-off';

export interface RestartEnvironmentInput {
  mode: RestartMode;
  discordToken: string;
  databaseUrl: string;
  stagingDatabaseUrl: string;
  /** Must already exist in an independently proven disposable database. */
  schema: string;
  syntheticActorIds: string;
  textChannelId: string;
  voiceChannelId: string;
  pseudonymKey: string;
  primaryActorId: string;
  readerIds: string;
  noticeChannelId: string;
}

/** No parent-env argument or spread: credentials are explicit, never inferred.
 * Returns sensitive values for spawn's env only; never serialize or log it.
 * URL/schema syntax is NOT proof of storage ownership. Unknown input properties
 * are deliberately not copied (including CREDENTIALS_DIRECTORY/NODE_OPTIONS).
 */
export function buildRestartEnvironment(input: RestartEnvironmentInput): Readonly<NodeJS.ProcessEnv> {
  try {
    if (!['notice-on', 'notice-off', 'master-off'].includes(input.mode)) throw new Error();
    if (!/^(?:test|staging_restart)_[a-z0-9_]{1,40}$/.test(input.schema)) throw new Error();
    for (const id of [input.textChannelId, input.voiceChannelId]) {
      if (!/^\d{17,20}$/.test(id)) throw new Error();
    }
    parseSyntheticStagingActorIds(input.syntheticActorIds);
    const env: NodeJS.ProcessEnv = {
      DISCORD_TOKEN: input.discordToken,
      TWO_DATABASE_URL: input.databaseUrl,
      TWO_STAGING_DATABASE_URL: input.stagingDatabaseUrl,
      PGOPTIONS: `-c search_path=${input.schema}`,
      DISCORD_GUILD_ID: TWO_STAGING_GUILD_ID,
      DISCORD_STAGING_GUILD_ID: TWO_STAGING_GUILD_ID,
      TWO_STAGING_RESTART_CONTAINMENT: '1',
      TWO_STAGING_RESTART_SYNTHETIC_ACTORS: input.syntheticActorIds,
      TWO_COMMUNITY_STAGING_GUILD_IDS: TWO_STAGING_GUILD_ID,
      TWO_COMMUNITY_HUMAN_CHANNEL_IDS: input.textChannelId,
      TWO_ONBOARDING_MODE: 'session',
      DISCORD_LANDING_CHANNEL_IDS: input.textChannelId,
      DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: input.textChannelId,
      DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: input.voiceChannelId,
      TWO_ONBOARDING_ROTA_MEASUREMENT: input.mode === 'master-off' ? '0' : '1',
      TWO_ONBOARDING_ROTA_NOTICE: input.mode === 'notice-off' ? '0' : '1',
      TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: input.pseudonymKey,
      TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID: input.primaryActorId,
      TWO_ONBOARDING_ROTA_READER_IDS: input.readerIds,
      DISCORD_STAFF_ALERT_CHANNEL_ID: input.noticeChannelId,
      TWO_HEALTH_PORT: '0',
      LOG_LEVEL: 'info',
    };
    if (Object.values(env).some((value) => typeof value !== 'string' || value.includes('\0'))) {
      throw new Error();
    }
    assertStagingRestartPreflight(env, {
      discordToken: input.discordToken,
      databaseUrl: input.databaseUrl,
      stagingDatabaseUrl: input.stagingDatabaseUrl,
      guildId: TWO_STAGING_GUILD_ID,
    });
    const rota = loadOnboardingRotaConfig(env);
    if (rota.enabled && rota.noticeEnabled && (!rota.primaryActorId || !rota.readerIds?.length)) {
      throw new Error();
    }
    return Object.freeze(env);
  } catch {
    // Underlying parsers can quote rejected input; do not expose their cause.
    throw new Error('Staging restart environment refused; check explicit bindings.');
  }
}

/** Verify tracked bytes, not merely HEAD or git status (which can hide changes
 * with assume-unchanged/skip-worktree). Only a standalone, non-symlink checkout
 * is accepted. All extra files, including ignored .env files, are refused except
 * .git and node_modules; installed dependencies require a separate integrity gate.
 * This is a point-in-time check, not an immutable launch sandbox or an approval.
 */
export function assertRestartSource(root: string, expectedCommit: string): void {
  const refused = () => new Error('Staging restart source refused; exact clean checkout required.');
  try {
    if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw refused();
    const cwd = resolve(root);
    if (realpathSync(cwd) !== cwd || !lstatSync(join(cwd, '.git')).isDirectory()) throw refused();
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['--no-optional-locks', ...args], {
      cwd,
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    }).toString('utf8');
    if (git('rev-parse', '--verify', 'HEAD').trim() !== expectedCommit) throw refused();
    if (git('diff', '--cached', '--name-only', expectedCommit, '--').trim()) throw refused();
    const tracked = new Set<string>();
    const directories = new Set<string>();
    for (const entry of git('ls-tree', '-rz', '--full-tree', expectedCommit).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match) throw refused(); // Symlinks, submodules and unusual paths are not launch inputs.
      const [, mode, hash, path] = match;
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
      if (path.split('/').some((part) => !part || part === '.' || part === '..')) throw refused();
      let current = cwd;
      for (const part of path.split('/')) {
        current = join(current, part);
        if (lstatSync(current).isSymbolicLink()) throw refused();
      }
      const stat = lstatSync(current);
      if (!stat.isFile() || ((stat.mode & 0o111) !== 0) !== (mode === '100755')) throw refused();
      const bytes = readFileSync(current);
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== hash) throw refused();
      tracked.add(path);
    }
    if (!tracked.has('src/index.ts') || !tracked.has('package-lock.json')) throw refused();
    const walk = (directory: string, prefix = '') => {
      for (const name of readdirSync(directory)) {
        const path = prefix ? `${prefix}/${name}` : name;
        const stat = lstatSync(join(directory, name));
        if (!prefix && (name === '.git' || name === 'node_modules')) {
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused();
          continue;
        }
        if (stat.isSymbolicLink()) throw refused();
        if (stat.isDirectory()) {
          if (!directories.has(path)) throw refused();
          walk(join(directory, name), path);
        } else if (!stat.isFile() || !tracked.has(path)) throw refused();
      }
    };
    walk(cwd);
  } catch {
    throw refused(); // Never surface git stderr, paths or file contents.
  }
}

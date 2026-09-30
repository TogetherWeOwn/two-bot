// Hermetic subprocess probe: replace startup before importing the real harness.
// Even a missing guard cannot launch a bot, open a socket, or read credentials.
import childProcess, { type SpawnOptions } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const healthUrl = new URL('../../scripts/health-check.ts', import.meta.url);
const mockUrl = new URL('../../tools/mock-discord/server.ts', import.meta.url).href;
const mode = process.argv[2];
// Set after this probe boots: poison only a hypothetical bot child preload.
process.env.NODE_OPTIONS = '--import=/__runbook_probe_credentials/inherited/preload.mjs';
const counts = { mockStarts: 0, spawns: 0, portHolds: 0, connects: 0, credentialReads: 0 };
let error = '';
let captured: NodeJS.ProcessEnv | undefined;
let effectiveDatabase: string | null = null;
let effectiveToken: string | null = null;

net.Socket.prototype.connect = function () {
  counts.connects++;
  throw new Error('probe refused network connection');
} as typeof net.Socket.prototype.connect;
const readFileSync = fs.readFileSync;
fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
  if (String(path).startsWith('/__runbook_probe_credentials')) {
    counts.credentialReads++;
    throw new Error('probe refused credential read');
  }
  return Reflect.apply(readFileSync, fs, [path, ...args]);
}) as typeof fs.readFileSync;
http.createServer = (() => {
  counts.portHolds++;
  return {
    listen(_port: number, _host: string, cb: () => void) { cb(); },
    address() { return { port: 43210 }; },
    close(cb: () => void) { cb(); },
  };
}) as typeof http.createServer;
childProcess.spawn = ((_cmd: string, _args?: unknown, options?: SpawnOptions) => {
  counts.spawns++;
  captured = options?.env;
  throw new Error('synthetic spawn reached');
}) as typeof childProcess.spawn;
syncBuiltinESMExports();

const globals = globalThis as typeof globalThis & { __runbookProbeStart: () => Promise<unknown> };
globals.__runbookProbeStart = async () => {
  counts.mockStarts++;
  if (!mode?.startsWith('environment')) throw new Error('synthetic startup reached');
  return {
    apiBase: 'http://127.0.0.1:43211/api/v10',
    guildId: 'synthetic-guild',
    close: async () => {},
  };
};
registerHooks({
  load(url, context, nextLoad) {
    if (url === mockUrl) {
      return {
        format: 'module', shortCircuit: true,
        source: 'export const startMockDiscord = () => globalThis.__runbookProbeStart();',
      };
    }
    return nextLoad(url, context);
  },
});

process.on('exit', () => {
  // Never serialize the inherited environment: only our synthetic inputs and
  // the harness-owned fields captured at the spawn boundary.
  const env = captured && Object.fromEntries([
    'CREDENTIALS_DIRECTORY', 'DISCORD_BOT_TOKEN', 'DISCORD_TOKEN',
    'DISCORD_API_BASE', 'DISCORD_GUILD_ID', 'TWO_DATABASE_URL',
    'TWO_HEALTH_PORT', 'TWO_HEALTH_BIND_HOST', 'PGOPTIONS', 'NODE_OPTIONS',
  ].map((key) => [key, captured![key] ?? null]));
  console.log('RUNBOOK_PROBE ' + JSON.stringify({ counts, error, env, effectiveDatabase, effectiveToken }));
});

try {
  if (mode === 'cli') {
    process.argv = [process.execPath, fileURLToPath(healthUrl)];
    await import(healthUrl.href);
  } else {
    const { runHealthCheck } = await import(healthUrl.href);
    try {
      await runHealthCheck({
        databaseUrl: process.env.TWO_DATABASE_URL ?? '',
        extraEnv: mode === 'environment' ? {
          CREDENTIALS_DIRECTORY: '/__runbook_probe_credentials/extra',
          DISCORD_BOT_TOKEN: 'hostile.extra.bot.token',
          DISCORD_TOKEN: 'hostile.extra.token',
          DISCORD_API_BASE: 'https://discord.invalid',
          DISCORD_GUILD_ID: 'hostile-guild',
          TWO_DATABASE_URL: 'postgres://extra:extra@db.invalid/extra',
          TWO_HEALTH_BIND_HOST: '0.0.0.0',
          TWO_HEALTH_PORT: '9999',
          NODE_OPTIONS: '--import=/__runbook_probe_credentials/extra/preload.mjs',
          PGOPTIONS: '-c search_path=card_test_schema',
        } : undefined,
      });
    } catch (err) {
      error = (err as Error).message;
    }
    if (captured) {
      const { credentialSource, readSecret } = await import('../../src/core/credentials.ts');
      const source = credentialSource(captured);
      effectiveDatabase = readSecret('database_url', ['TWO_DATABASE_URL'], source);
      effectiveToken = readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN'], source);
    }
  }
} catch (err) {
  error = (err as Error).message;
  process.exitCode = 1;
}

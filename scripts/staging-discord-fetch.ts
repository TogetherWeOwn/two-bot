import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Library: shared proof-only Discord 429 transport. Importing this file never
// reads argv and never exits; the block below only runs on direct invocation.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log('usage: node scripts/staging-discord-fetch.ts --help');
  console.log('');
  console.log('Shared proof-only Discord 429 transport (library, no direct invocation).');
  console.log('Imported by scripts/staging-announcements-proof.ts and scripts/staging-announcements-verify.ts.');
  console.log('');
  console.log('Flags:');
  console.log('  --help  Show this help and exit.');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/staging-discord-fetch.ts --help');
  console.log('');
  console.log('No token, no network, no side effects on --help.');
  process.exit(process.argv.includes('--help') ? 0 : 2);
}

/**
 * Proof-only transport: Discord 429 means the request was rejected, so it is
 * safe to retry after the advertised delay. Never retry network/5xx failures
 * (a write may already have happened), permission denials or malformed requests.
 * Does not change the production clients' retry policy or caller timeouts.
 */
export function proofDiscordFetch(options: {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  onRateLimit?: (ms: number) => void;
} = {}): typeof fetch {
  const request = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (async (ms, signal) => { await setTimeout(ms, undefined, { signal: signal ?? undefined }); });
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let attempt = 0; ; attempt++) {
      const response = await request(input, init);
      if (response.status !== 429 || attempt >= 2) return response;
      let seconds: unknown;
      try { seconds = (await response.clone().json() as { retry_after?: unknown }).retry_after; }
      catch { return response; }
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 30) return response;
      const ms = Math.ceil(seconds * 1000) + 250;
      options.onRateLimit?.(ms);
      await sleep(ms, signal);
    }
  };
}

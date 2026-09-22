// Deliberate test-only mutant. No checked-out production file is modified.
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const target = resolve(import.meta.dirname, '../../src/discord/client.ts');
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith('file:') || fileURLToPath(url) !== target) return loaded;
    const source = String(loaded.source);
    const dispatch = 'void deps.onboardingRota?.message(msg, inspection);';
    if (source.split(dispatch).length !== 2) throw new Error('rota mutation target changed');
    console.log('rota_test_mutation_applied');
    return { ...loaded, source: source.replace(dispatch, 'void inspection;') };
  },
});

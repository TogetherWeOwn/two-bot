/**
 * Manage tracked invite links (TOG-116).
 *
 *   npm run campaigns                                       # list
 *   npm run campaigns -- --add reddit aB3xY9 "r/MMORPG sidebar"
 *   npm run campaigns -- --retire reddit
 *
 * Adding a link is a community decision made at the moment somebody is about to
 * post somewhere. It must not need a deploy, an engineer, or a code review, so
 * it is a row in a table and this is the tool that writes it.
 *
 * Give each place its OWN Discord invite code. Two campaigns can share a code
 * and the report still separates them by campaign, but joins can only ever be
 * attributed to a code - so sharing one means you learn which link was clicked
 * and never which one produced members, and members are the point.
 */
import { openDb } from '../src/store/db.ts';
import { CampaignStore, isValidSlug } from '../src/redirect/campaigns.ts';

const argv = process.argv.slice(2);
const flagAt = (name: string) => argv.indexOf(`--${name}`);

const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';
const db = await openDb(dbSpec, { applicationName: 'two-bot-campaigns' });
const store = new CampaignStore(db);

const base = process.env.TWO_REDIRECT_BASE_URL || 'https://go.two.gg';

try {
  const addAt = flagAt('add');
  const retireAt = flagAt('retire');

  if (addAt !== -1) {
    const [slug, code, ...rest] = argv.slice(addAt + 1);
    const label = rest.join(' ').trim();
    if (!slug || !code || !label) {
      fail('usage: npm run campaigns -- --add <slug> <invite-code> "<where you post it>"');
    }
    if (code.includes('/')) {
      fail(`Pass the invite code only, not a URL. From https://discord.gg/aB3xY9 that is "aB3xY9".`);
    }
    await store.add({ slug, inviteCode: code, label, createdAt: new Date().toISOString() });
    console.log(`added ${slug} -> discord.gg/${code}`);
    console.log(`\n  post this link:  ${base}/${slug}\n`);
  } else if (retireAt !== -1) {
    const slug = argv[retireAt + 1];
    if (!slug) fail('usage: npm run campaigns -- --retire <slug>');
    if (!isValidSlug(slug)) fail(`"${slug}" is not a valid slug.`);
    const done = await store.disable(slug, new Date().toISOString());
    console.log(
      done
        ? `retired ${slug}. The link keeps redirecting - anything already posted still works.`
        : `${slug} is not an active campaign (already retired, or never existed).`,
    );
  } else {
    const all = await store.list();
    if (all.length === 0) {
      console.log('\nNo tracked links yet. Every go.two.gg URL 404s until there is one.\n');
      console.log('  npm run campaigns -- --add reddit aB3xY9 "r/MMORPG sidebar"\n');
    } else {
      console.log(`\nTracked invite links (${base}/<slug>)\n`);
      const w = Math.max(...all.map((c) => c.slug.length), 4);
      for (const c of all) {
        const state = c.disabledAt ? '  retired' : '';
        console.log(`  ${c.slug.padEnd(w)}  ->  discord.gg/${c.inviteCode}   ${c.label}${state}`);
      }
      console.log('\n  Clicks per link: npm run funnel\n');
    }
  }
} finally {
  await db.close();
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

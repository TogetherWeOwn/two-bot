/**
 * Weekly community scorecard: scores the previous closed week and prints the
 * result as JSON (exit 2 when coverage is incomplete).
 *
 * TOG-8294 `--dry-run`: print the same scorecard with zero side effects — no
 * `community_scorecard_runs` row, no alert row, and migrations are skipped so
 * even an unmigrated database is left untouched (it fails loudly on the first
 * SELECT instead of being migrated). `generatedAt` is pinned to the
 * closed-week end, so two dry-runs of the same week print byte-identical JSON.
 *
 *   node scripts/community-scorecard.ts --dry-run
 */
import { openDb } from '../src/store/db.ts';
import { runPreviousClosedCommunityWeek } from '../src/analytics/communityScorecard.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log('usage: node scripts/community-scorecard.ts [--dry-run]');
  process.exit(0);
}
const dryRun = rawArgs.includes('--dry-run');

const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required.');
const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) throw new Error('DISCORD_GUILD_ID is required.');

const classifier = new CommunityClassifier(loadCommunityClassifierConfig());
const db = await openDb(databaseUrl, {
  applicationName: 'two-bot-community-scorecard',
  // TOG-8294: a dry-run must not write even schema_migrations.
  skipMigrations: dryRun,
});
try {
  const result = await runPreviousClosedCommunityWeek(db, guildId, classifier.version, {
    recommendationsEnabled: process.env.TWO_COMMUNITY_RECOMMENDATIONS !== '0',
    correctionCycles: Number(process.env.TWO_COMMUNITY_CORRECTION_CYCLES ?? 0),
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.scorecard.coverageState === 'incomplete') process.exitCode = 2;
} finally {
  await db.close();
}

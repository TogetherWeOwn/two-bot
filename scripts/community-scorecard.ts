import { openDb } from '../src/store/db.ts';
import { runPreviousClosedCommunityWeek } from '../src/analytics/communityScorecard.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';

const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required.');
const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) throw new Error('DISCORD_GUILD_ID is required.');

const classifier = new CommunityClassifier(loadCommunityClassifierConfig());
const db = await openDb(databaseUrl, { applicationName: 'two-bot-community-scorecard' });
try {
  const result = await runPreviousClosedCommunityWeek(db, guildId, classifier.version, {
    recommendationsEnabled: process.env.TWO_COMMUNITY_RECOMMENDATIONS !== '0',
    correctionCycles: Number(process.env.TWO_COMMUNITY_CORRECTION_CYCLES ?? 0),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.scorecard.coverageState === 'incomplete') process.exitCode = 2;
} finally {
  await db.close();
}

/**
 * Hand-computed dry-run fixture for the community snapshot jobs (TOG-7191).
 *
 * WHY THIS EXISTS. `test/unit.communitysnapshots.test.ts` proves the snapshot
 * arithmetic on small synthetic rosters and `test/unit.communityscorecard.test.ts`
 * proves each scorecard rule on focused fixtures, but nothing pins the two
 * together end to end: one seeded roster plus one seeded week, both jobs run,
 * and the resulting snapshot JSON must equal these hand-computed values
 * exactly. If a future change moves any number (a rank definition, the raid
 * exclusion set, an evidence threshold), this file is the one place that says
 * what the numbers should be, and the test fails with the diff.
 *
 * THE ROSTER, by hand. Nine Discord members, three rank roles referenced:
 *   - alice holds prospect only -> highest rank prospect
 *   - bob holds prospect+member (nested) -> highest rank member
 *   - carol holds all five (nested) -> highest rank legend
 *   - dave holds nothing -> rankKey null, still a counted human
 *   - erin holds prospect+member+soldier (nested) -> highest rank soldier
 *   - bot-1 is a bot -> excluded from humans, excluded from ranks
 *   - raid-0/raid-1/raid-2 sit in the three real raid windows
 *     (2025-07-06, 2025-09-12, 2025-12-15) -> excluded from humans and ranks,
 *     recorded in member_exclusions
 *
 * Included humans: alice, bob, carol, dave, erin = 5.
 * Ranked (hold at least one rank role): alice, bob, carol, erin = 4.
 * Highest-rank counts: prospect 1 (alice), member 1 (bob), soldier 1 (erin),
 * veteran 0, legend 1 (carol).
 * Holders (every role held, not just highest): prospect 4 (alice, bob, carol,
 * erin), member 3 (bob, carol, erin), soldier 2 (carol, erin), veteran 1
 * (carol), legend 1 (carol).
 * raidAccountsExcluded counts roster members in the exclusion set even when
 * they hold rank roles: 3.
 *
 * THE WEEK, by hand. Five eligible_human messages in the human channel class,
 * one per actor, full stream coverage of the closed week 2026-08-31..2026-09-07:
 *   - rawFactCount 5, weeklyActiveHumans 5, humanMessages 5, eligibleJoins 0
 *   - botNoise numerator 0 / denominator 5, ratio 0, alert false
 *   - five distinct evidence humans -> evidenceState sufficient
 *   - no joins -> firstHumanReply all zeros, median null
 *   - coverage complete, nothing breached -> intervention HOLD
 *
 * NOTHING HERE IS A REAL PERSON. Member ids are first names, role ids are
 * `role-<rank>` sentinels, and the guild id is a literal label. No Discord
 * snowflakes, so the src snowflake ratchet is unaffected.
 */

export const DRYRUN_GUILD = 'dryrun-guild';
export const DRYRUN_NOW = '2026-09-07T06:15:00.000Z';
export const DRYRUN_WEEK_START = '2026-08-31T00:00:00.000Z';
export const DRYRUN_WEEK_END = '2026-09-07T00:00:00.000Z';
export const DRYRUN_CLASSIFIER_VERSION = 'community-test-v1';

export interface DryrunRosterMember {
  id: string;
  heldRanks: string[];
  bot: boolean;
}

/** The nine-member roster described above, in stable order. */
export const DRYRUN_ROSTER: DryrunRosterMember[] = [
  { id: 'alice', heldRanks: ['prospect'], bot: false },
  { id: 'bob', heldRanks: ['prospect', 'member'], bot: false },
  { id: 'carol', heldRanks: ['prospect', 'member', 'soldier', 'veteran', 'legend'], bot: false },
  { id: 'dave', heldRanks: [], bot: false },
  { id: 'erin', heldRanks: ['prospect', 'member', 'soldier'], bot: false },
  { id: 'bot-1', heldRanks: ['prospect', 'member', 'soldier', 'veteran', 'legend'], bot: true },
  { id: 'raid-0', heldRanks: ['prospect', 'member', 'soldier', 'veteran', 'legend'], bot: false },
  { id: 'raid-1', heldRanks: ['prospect', 'member', 'soldier', 'veteran', 'legend'], bot: false },
  { id: 'raid-2', heldRanks: ['prospect', 'member', 'soldier', 'veteran', 'legend'], bot: false },
];

/** Which raid window each raid account grounds: member -> anomaly id. */
export const DRYRUN_RAID_GROUNDING: Record<string, string> = {
  'raid-0': '2025-07-06-raid',
  'raid-1': '2025-12-15-raid',
  'raid-2': '2025-09-12-raid',
};

/** The exact snapshot `buildCommunitySnapshot` must return for the roster. */
export const EXPECTED_SNAPSHOT = {
  humanMemberCount: 5,
  rankedMemberCount: 4,
  rankRows: [
    { key: 'prospect', label: 'Prospect', order: 1, roleId: 'role-prospect', memberCount: 1, holdersCount: 4 },
    { key: 'member', label: 'Member', order: 2, roleId: 'role-member', memberCount: 1, holdersCount: 3 },
    { key: 'soldier', label: 'Soldier', order: 3, roleId: 'role-soldier', memberCount: 1, holdersCount: 2 },
    { key: 'veteran', label: 'Veteran', order: 4, roleId: 'role-veteran', memberCount: 0, holdersCount: 1 },
    { key: 'legend', label: 'Legend', order: 5, roleId: 'role-legend', memberCount: 1, holdersCount: 1 },
  ],
  memberRanks: [
    { memberId: 'alice', rankKey: 'prospect' },
    { memberId: 'bob', rankKey: 'member' },
    { memberId: 'carol', rankKey: 'legend' },
    { memberId: 'dave', rankKey: null },
    { memberId: 'erin', rankKey: 'soldier' },
  ],
  excludedMemberIds: ['raid-0', 'raid-2', 'raid-1'],
  nested: true,
  raidAccountsExcluded: 3,
};

/** Five eligible_human messages, one actor each, all in a human channel. */
export const DRYRUN_WEEK_MESSAGES = [
  { id: 'dryrun-m-0', actorId: 'dryrun-human-0', occurredAt: '2026-09-01T10:00:00.000Z' },
  { id: 'dryrun-m-1', actorId: 'dryrun-human-1', occurredAt: '2026-09-01T10:01:00.000Z' },
  { id: 'dryrun-m-2', actorId: 'dryrun-human-2', occurredAt: '2026-09-01T10:02:00.000Z' },
  { id: 'dryrun-m-3', actorId: 'dryrun-human-3', occurredAt: '2026-09-01T10:03:00.000Z' },
  { id: 'dryrun-m-4', actorId: 'dryrun-human-4', occurredAt: '2026-09-01T10:04:00.000Z' },
];

/** The exact scorecard the week seed must produce (volatile fields omitted). */
export const EXPECTED_SCORECARD = {
  guildId: DRYRUN_GUILD,
  weekStart: DRYRUN_WEEK_START,
  weekEnd: DRYRUN_WEEK_END,
  generatedAt: DRYRUN_NOW,
  classifierVersion: DRYRUN_CLASSIFIER_VERSION,
  watermark: 5,
  idempotencyKey: `community-health:${DRYRUN_GUILD}:2026-08-31:${DRYRUN_CLASSIFIER_VERSION}:5`,
  revision: 1,
  coverageState: 'complete',
  evidenceState: 'sufficient',
  rawFactCount: 5,
  weeklyActiveHumans: 5,
  humanMessages: 5,
  eligibleJoins: 0,
  joinSources: { known: 0, unknown: 0 },
  eventAttendance: { participations: 0, distinctHumans: 0 },
  botNoise: { numerator: 0, denominator: 5, ratio: 0, alert: false },
  firstHumanReply: {
    medianSeconds: null,
    resolvedCount: 0,
    eligibleJoinCount: 0,
    noReplyWithin24hCount: 0,
    pendingCount: 0,
  },
  ingestionErrors: [],
  intervention: { code: 'HOLD', reason: 'no threshold crossed; continue the current intervention' },
  recommendationsEnabled: true,
  killSwitchActive: false,
};

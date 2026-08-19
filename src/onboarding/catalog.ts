/**
 * What a new member can pick, and where each pick sends them.
 *
 * Every id below is a real id on the TWO server (326474832151838730), read
 * from the live API on 2026-08-19 - not invented. `scripts/verify-catalog.ts`
 * re-checks all of them against Discord and fails loudly if someone renames or
 * deletes one, which is the only way this file can silently rot.
 *
 * Two rules keep this honest:
 *
 *   1. We only offer roles the bot can actually assign. The bot's highest role
 *      is `Prospect` (position 105), so every role here sits below that.
 *      Anything higher (Member, Initiate, Unverified) is deliberately absent -
 *      the bot must not be the thing that gates membership.
 *
 *   2. Every pick has a `fallbackChannelId`. The three dedicated game
 *      categories are currently invisible to everyone (see docs/ROUTING.md),
 *      so routing a member to `shooters-general` today would send them to a
 *      channel they cannot open. Until that is fixed we send them somewhere
 *      real. See `resolveDestination()` in flow.ts.
 */

export const GUILD_ID = '326474832151838730';

/** 🎮〢game-hub - a forum every verified Member can already see. */
export const GAME_HUB_CHANNEL_ID = '1092312335529541632';

/** 📰〢introduce-yourself - where we point people after they pick. */
export const INTRO_CHANNEL_ID = '1087198966346690570';

export interface GamePick {
  /** Stable key. Goes in the select-menu value and in event metadata. */
  key: string;
  /** Shown in the picker. */
  label: string;
  /** Shown under the label. Keep it short - Discord truncates at 100 chars. */
  description: string;
  emoji: string;
  /** Role granted on pick. Must be below the bot's highest role. */
  roleId: string;
  roleName: string;
  /**
   * Where this pick is meant to land. `null` means the interest has a role but
   * no dedicated room, so the hub is the honest destination.
   */
  primaryChannelId: string | null;
  /** Used when `primaryChannelId` is not visible to the member. */
  fallbackChannelId: string;
}

/**
 * The three picks with purpose-built categories. These are the ones that make
 * "landed in a channel about a game they actually play" literally true, and
 * the ones blocked on the permission fix.
 */
export const GAME_PICKS: GamePick[] = [
  {
    key: 'shooters',
    label: 'Shooters',
    description: 'CS, Siege, CoD, Battlefield, Valorant',
    emoji: '🎯',
    roleId: '1051272877871222915',
    roleName: 'Shooter Games',
    primaryChannelId: '1179217198930202735', // 💬〢shooters-general
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'survival',
    label: 'Survival',
    description: 'Rust, DayZ, Ark, Valheim, Palworld',
    emoji: '🎮',
    roleId: '1179233034713702511',
    roleName: 'Survival Games',
    primaryChannelId: '1178937094035492884', // 💬〢survival-general
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'horror',
    label: 'Horror',
    description: 'Phasmophobia, Lethal Company, Dead by Daylight',
    emoji: '👻',
    roleId: '1119666971584237679',
    roleName: 'Horror Games',
    primaryChannelId: '1118994447036850369', // 💬〢horror-general
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  // --- roles that exist but have no dedicated room -------------------------
  // Offering these still helps: the role is what LFG pings and future channel
  // splits key off, and picking one tells us what the community actually
  // plays. They route to the hub because that is where those conversations
  // genuinely happen today.
  {
    key: 'counterstrike',
    label: 'Counter-Strike',
    description: 'CS2 specifically',
    emoji: '💣',
    roleId: '1179233301295284385',
    roleName: 'CounterStrike',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'rocketleague',
    label: 'Rocket League',
    description: 'Car football',
    emoji: '🚀',
    roleId: '1065438504521322526',
    roleName: 'rocketleague',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'fallguys',
    label: 'Fall Guys',
    description: 'Beans',
    emoji: '🫘',
    roleId: '1065438396069191700',
    roleName: 'fallguys',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'warthunder',
    label: 'War Thunder',
    description: 'Tanks and planes',
    emoji: '🛩️',
    roleId: '1065438198316138507',
    roleName: 'warthunder',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'retro',
    label: 'Retro',
    description: 'Anything pre-2005',
    emoji: '🕹️',
    roleId: '1063255307410739241',
    roleName: 'Retro Games',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'tabletop',
    label: 'Tabletop',
    description: 'D&D, board games, TCGs',
    emoji: '🎲',
    roleId: '1063255343884406864',
    roleName: 'Tabletop Games',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'pokemon',
    label: 'Pokemon',
    description: 'Main series, TCG, GO',
    emoji: '⚡',
    roleId: '1063245872328081439',
    roleName: 'Pokemon',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
];

/**
 * Platform is a second, optional question. It is cheap to answer, it is what
 * the game-hub forum tags are already keyed on, and 47 of 84 current members
 * have one - so it is a question this community clearly likes answering.
 */
export const PLATFORM_PICKS: GamePick[] = [
  {
    key: 'pc',
    label: 'PC',
    description: '',
    emoji: '🖥️',
    roleId: '1092247753574330458',
    roleName: 'PC',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'xbox',
    label: 'Xbox',
    description: '',
    emoji: '🟩',
    roleId: '1087930995875008522',
    roleName: 'Xbox',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'playstation',
    label: 'PlayStation',
    description: '',
    emoji: '🔵',
    roleId: '1087931108945039470',
    roleName: 'Playstation',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'switch',
    label: 'Switch',
    description: '',
    emoji: '🔴',
    roleId: '1092248449786855595',
    roleName: 'Switch',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
  {
    key: 'mobile',
    label: 'Mobile',
    description: '',
    emoji: '📱',
    roleId: '1092250849717264475',
    roleName: 'Mobile',
    primaryChannelId: null,
    fallbackChannelId: GAME_HUB_CHANNEL_ID,
  },
];

/**
 * The three categories that are dark today, and the role that should light
 * each one up. `scripts/apply-game-channel-access.ts` reads this and nothing
 * else, so the permission change the CEO approves is exactly this table.
 */
export const GATED_CATEGORIES = [
  {
    categoryId: '1178936839151816715',
    categoryName: '🎮【 Survival 】🎮',
    roleId: '1179233034713702511',
    roleName: 'Survival Games',
  },
  {
    categoryId: '1179216170591715348',
    categoryName: '🎯【 Shooters 】🎯',
    roleId: '1051272877871222915',
    roleName: 'Shooter Games',
  },
  {
    categoryId: '1178933610586308739',
    categoryName: '👻【 Horror 】👻',
    roleId: '1119666971584237679',
    roleName: 'Horror Games',
  },
] as const;

export const ALL_PICKS: GamePick[] = [...GAME_PICKS, ...PLATFORM_PICKS];

export function pickByKey(key: string): GamePick | undefined {
  return ALL_PICKS.find((p) => p.key === key);
}

/** Discord hard-caps a string select at 25 options. Fail at build, not at runtime. */
if (GAME_PICKS.length > 25 || PLATFORM_PICKS.length > 25) {
  throw new Error('catalog: a select menu cannot offer more than 25 options');
}

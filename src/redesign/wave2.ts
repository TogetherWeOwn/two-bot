/**
 * Deciding what Wave 2 of the TOG-34 redesign should create, with no network
 * in sight.
 *
 * `scripts/wave2-additive.ts` is the I/O half; this is the thinking half. Same
 * split, and the same reason, as `src/staging/provision.ts`: everything that
 * could get the answer wrong is testable without a token, without a guild, and
 * without the ability to do damage.
 *
 * WHAT WAVE 2 IS ALLOWED TO DO
 *
 * `server-redesign` rev 6 §7: *"Wave 2 - Additive only. Create the 4
 * categories. Create #looking-to-play. Create the Verified role. Nothing is
 * hidden, nothing moves."* §9 rates its rollback at "Delete 4 categories, 1
 * channel, 1 role. Seconds."
 *
 * So the planner below only ever emits creates. There is no delete, rename,
 * move or permission-strip verb in this module or in the script that drives
 * it, which is what makes "additive only" a property of the code rather than a
 * promise in a comment.
 *
 * WHY IT MATCHES ON NAME AND TYPE, AND WHY THAT MATTERS
 *
 * Re-running Wave 2 must not produce a second `#looking-to-play`. Discord will
 * happily create duplicate channels and duplicate roles with the same name, and
 * a half-finished wave that someone re-runs is the normal way that happens.
 * `planWave2` therefore diffs against what is already there and returns only
 * the missing pieces, so the wave is idempotent: run it twice and the second
 * run creates nothing.
 *
 * THE ONE PERMISSION WRITE IN HERE, AND WHY IT IS STILL ADDITIVE
 *
 * `⚙️ SYSTEM` is created with an `@everyone` View deny already on it (§4.3:
 * *"The ⚙️ SYSTEM category denies @everyone View at the category level and the
 * four channels inherit it."*). That is a deny on a category that is empty at
 * the moment it is created, so it hides nothing that exists. Creating it right
 * the first time is cheaper and safer than creating it open and remembering to
 * close it in a later wave - a category that is briefly public is exactly the
 * kind of thing nobody notices until a log channel has been world-readable for
 * a day.
 */

/** Discord channel types. Only the three Wave 2 can produce. */
export const CHANNEL_TYPE_TEXT = 0;
export const CHANNEL_TYPE_VOICE = 2;
export const CHANNEL_TYPE_CATEGORY = 4;

/** Permission bit for View Channel, used for the SYSTEM category deny. */
export const VIEW_CHANNEL = 1n << 10n;

/** The live TWO guild. Named so a misdirected run is obvious in a diff. */
export const LIVE_GUILD_ID = '326474832151838730';

/**
 * The four categories, in the order rev 6 §4.1 draws them.
 *
 * `hidden` marks the one that is created with an `@everyone` View deny. It is
 * a property of the category rather than a separate wave step, see the header.
 */
export interface CategorySpec {
  name: string;
  hidden: boolean;
}

export const WAVE2_CATEGORIES: readonly CategorySpec[] = [
  { name: '📌 START HERE', hidden: false },
  { name: '💬 CHAT', hidden: false },
  { name: '🔊 VOICE', hidden: false },
  { name: '⚙️ SYSTEM', hidden: true },
] as const;

/**
 * The single channel Wave 2 creates. Everything else in the target tree is a
 * rename of an existing channel in Wave 3 - see `execution-gate` §3, which
 * pins all nine of those to channel ids precisely so that no executor
 * "helpfully" creates a second #general and loses the history.
 */
export const LOOKING_TO_PLAY = {
  name: 'looking-to-play',
  type: CHANNEL_TYPE_TEXT,
  parentCategory: '💬 CHAT',
  topic:
    "Post when you're online and want people to play with. Say the game and roughly when. " +
    '"Anyone up for anything?" is a perfectly good post.',
} as const;

/**
 * The role Wave 2 creates.
 *
 * Permissions are `'0'` deliberately. Rev 6 §4.4: *"Verified unlocks nothing at
 * launch - and that is deliberate. The moment it gates a channel it becomes a
 * second gate, and you asked for fewer."* Whether that changes is decision D3,
 * which is the owner's and which gates nothing before Wave 7.
 *
 * The colour is not specified anywhere in rev 6, which asks only for "hoisted,
 * coloured". Green is chosen here so the value is in code rather than
 * re-improvised per run; it is cosmetic and one PATCH to change.
 */
export const VERIFIED_ROLE = {
  name: 'Verified',
  /** No permissions at all. Not "the same as @everyone" - literally none. */
  permissions: '0',
  /** Shown as its own group in the member list. This is the whole point of it. */
  hoist: true,
  /** 0x2ECC71. Cosmetic; rev 6 §4.4 asks for "coloured" without saying which. */
  color: 0x2ecc71,
  mentionable: false,
} as const;

/** What we can see of a channel that already exists. */
export interface PartialChannel {
  id: string;
  name?: string;
  type: number;
  parent_id?: string | null;
}

/** What we can see of a role that already exists. */
export interface PartialRole {
  id: string;
  name: string;
  managed?: boolean;
}

export interface CategoryAction {
  name: string;
  hidden: boolean;
}

export interface ChannelAction {
  name: string;
  type: number;
  topic: string;
  parentCategory: string;
}

export interface Wave2Plan {
  /** Categories that do not exist yet, in rev 6 §4.1 order. */
  createCategories: CategoryAction[];
  /** Empty once `#looking-to-play` exists. */
  createChannels: ChannelAction[];
  /** Empty once `Verified` exists. */
  createRoles: Array<typeof VERIFIED_ROLE>;
  /** Target names already present. Re-running is a no-op, not an error. */
  present: string[];
  /**
   * Target names present more than once. Wave 2 never creates a duplicate, so
   * seeing one means a previous run half-failed or somebody made it by hand.
   * Reported rather than repaired: deleting the wrong one is destructive and
   * this wave does not delete.
   */
  duplicates: string[];
}

/**
 * Diff the target against what is on the server right now.
 *
 * Categories and the channel are matched on name AND type, because a text
 * channel called `💬 CHAT` is not the `💬 CHAT` category and treating it as one
 * would skip a create and leave the wave silently incomplete. Roles are matched
 * on name alone, which is all Discord gives us, with managed roles excluded -
 * an integration role that happens to be called `Verified` is not ours and
 * cannot be made to behave like ours.
 */
export function planWave2(existing: {
  channels: PartialChannel[];
  roles: PartialRole[];
}): Wave2Plan {
  const plan: Wave2Plan = {
    createCategories: [],
    createChannels: [],
    createRoles: [],
    present: [],
    duplicates: [],
  };

  for (const cat of WAVE2_CATEGORIES) {
    const hits = existing.channels.filter(
      (c) => c.name === cat.name && c.type === CHANNEL_TYPE_CATEGORY,
    );
    if (hits.length === 0) plan.createCategories.push({ name: cat.name, hidden: cat.hidden });
    else {
      plan.present.push(cat.name);
      if (hits.length > 1) plan.duplicates.push(cat.name);
    }
  }

  const chanHits = existing.channels.filter(
    (c) => c.name === LOOKING_TO_PLAY.name && c.type === LOOKING_TO_PLAY.type,
  );
  if (chanHits.length === 0) {
    plan.createChannels.push({
      name: LOOKING_TO_PLAY.name,
      type: LOOKING_TO_PLAY.type,
      topic: LOOKING_TO_PLAY.topic,
      parentCategory: LOOKING_TO_PLAY.parentCategory,
    });
  } else {
    plan.present.push(`#${LOOKING_TO_PLAY.name}`);
    if (chanHits.length > 1) plan.duplicates.push(`#${LOOKING_TO_PLAY.name}`);
  }

  const roleHits = existing.roles.filter((r) => r.name === VERIFIED_ROLE.name && !r.managed);
  if (roleHits.length === 0) plan.createRoles.push(VERIFIED_ROLE);
  else {
    plan.present.push(VERIFIED_ROLE.name);
    if (roleHits.length > 1) plan.duplicates.push(VERIFIED_ROLE.name);
  }

  return plan;
}

/** True when there is nothing left to do. Used for the exit code. */
export function planIsComplete(plan: Wave2Plan): boolean {
  return (
    plan.createCategories.length === 0 &&
    plan.createChannels.length === 0 &&
    plan.createRoles.length === 0
  );
}

/**
 * The `permission_overwrites` a new category is created with.
 *
 * Only `⚙️ SYSTEM` gets one: a single `@everyone` deny on View. The
 * `@everyone` role id is always the guild id, which is why this needs the
 * guild rather than a role lookup.
 */
export function categoryOverwrites(
  cat: CategorySpec,
  guildId: string,
): Array<{ id: string; type: number; allow: string; deny: string }> {
  if (!cat.hidden) return [];
  // type 0 = role overwrite. @everyone's role id is the guild id.
  return [{ id: guildId, type: 0, allow: '0', deny: VIEW_CHANNEL.toString() }];
}

/**
 * Roles the running bot hands out that Wave 6 destroys.
 *
 * NOT a Wave 2 step, and deliberately computed here anyway. Rev 6 §4.6 spotted
 * that Discord's *native* Onboarding prompts "grant role IDs that are about to
 * stop existing" and has Wave 4 delete them. Our own bot's onboarding catalog
 * has exactly the same problem and no wave addresses it: every role in
 * `src/onboarding/catalog.ts` is a game/platform role, and rev 6 §4.4 deletes
 * every game and platform role in Wave 6.
 *
 * The failure is silent in the worst way. `flow.ts` grants the role and routes
 * the member; after Wave 6 the grant 404s against a role id that no longer
 * exists, and the funnel records somebody who "chose not to pick a game".
 * That is the same shape as the TOG-78 finding this card carries forward.
 *
 * Reported by the Wave 2 script as a warning, because Wave 2 is the last point
 * where it is still cheap to fix and because a warning printed five waves early
 * is worth more than a correct one printed too late.
 */
export function catalogRolesDestroyedByWave6(opts: {
  catalogRoleIds: readonly string[];
  roles: PartialRole[];
}): Array<{ id: string; name: string }> {
  const byId = new Map(opts.roles.map((r) => [r.id, r]));
  const doomed: Array<{ id: string; name: string }> = [];
  for (const id of new Set(opts.catalogRoleIds)) {
    const role = byId.get(id);
    // A role we cannot see is already gone; Wave 6 is not what breaks it.
    // A managed role survives Wave 6 - it goes with its integration in Wave 7.
    if (role && !role.managed) doomed.push({ id, name: role.name });
  }
  return doomed;
}

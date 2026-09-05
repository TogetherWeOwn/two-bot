/**
 * "Can the bot post in this channel?", resolved the way Discord resolves it.
 *
 * The guild-wide permission integer preflight reads from /users/@me/guilds says
 * nothing about one channel: a channel's @everyone overwrite can deny View to a
 * bot that holds Manage Server everywhere else. That gap is not hypothetical.
 * On the live TWO server the staff alert channel denies View to @everyone, the
 * bot's roles (Prospect, Owen) are not Staff, and the only reason alerts are
 * deliverable today is Administrator - which TOG-64 is in the middle of
 * removing. When it goes, makeRaidAnnouncer() takes its 'raid_alert_undeliverable'
 * branch and a join burst becomes a line in a log nobody reads.
 *
 * This lives in src/ rather than inline in the script so the bit arithmetic is
 * unit-testable without a token or a network. discord.js does the same job via
 * channel.permissionsFor(), but preflight runs against the REST API before any
 * gateway client exists, so it cannot borrow that.
 */

export const VIEW_CHANNEL = 1n << 10n;
export const SEND_MESSAGES = 1n << 11n;
export const ADMINISTRATOR = 1n << 3n;

export interface Overwrite {
  id: string;
  /** 0 = role, 1 = member. */
  type: number;
  allow: string;
  deny: string;
}

export interface ChannelAccess {
  view: boolean;
  send: boolean;
  /**
   * True when the answer is "yes, but only because Administrator bypasses every
   * overwrite". Callers report this separately: it is a pass that is about to
   * stop being one.
   */
  admin: boolean;
}

export interface ChannelAccessInput {
  guildId: string;
  botId: string;
  /** From GET /guilds/{id}/members/{botId}. Excludes @everyone, as Discord does. */
  botRoleIds: string[];
  /** From GET /guilds/{id}/roles. */
  guildRoles: { id: string; permissions: string }[];
  overwrites: Overwrite[];
}

/**
 * Discord's documented order: start from the union of role permissions, apply
 * the @everyone overwrite, then the union of role overwrites, then the
 * member-specific one - denies before allows at each step. Administrator
 * short-circuits the whole computation.
 */
export function resolveChannelAccess(input: ChannelAccessInput): ChannelAccess {
  const held = new Set(input.botRoleIds);
  held.add(input.guildId); // @everyone is always held and never listed in member.roles

  let base = 0n;
  for (const r of input.guildRoles) {
    if (held.has(r.id)) base |= BigInt(r.permissions);
  }
  if (base & ADMINISTRATOR) return { view: true, send: true, admin: true };

  const everyone = input.overwrites.find((o) => o.id === input.guildId);
  if (everyone) base = (base & ~BigInt(everyone.deny)) | BigInt(everyone.allow);

  // Role overwrites are unioned and applied together, so one role's allow beats
  // another role's deny. Only then does a member-specific overwrite win.
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of input.overwrites) {
    if (o.id !== input.guildId && o.type === 0 && held.has(o.id)) {
      roleAllow |= BigInt(o.allow);
      roleDeny |= BigInt(o.deny);
    }
  }
  base = (base & ~roleDeny) | roleAllow;

  const member = input.overwrites.find((o) => o.type === 1 && o.id === input.botId);
  if (member) base = (base & ~BigInt(member.deny)) | BigInt(member.allow);

  return {
    view: (base & VIEW_CHANNEL) !== 0n,
    // Send is meaningless without View: Discord delivers neither.
    send: (base & VIEW_CHANNEL) !== 0n && (base & SEND_MESSAGES) !== 0n,
    admin: false,
  };
}

/**
 * Tracked invite links: the slug rules and the store behind them (TOG-116).
 *
 * Nothing in this file opens a socket. The HTTP layer is server.ts; this is the
 * part that decides what a legal slug is and what a slug resolves to, so both
 * can be tested without a listener.
 */
import type { Db } from '../store/driver.ts';

export interface Campaign {
  slug: string;
  inviteCode: string;
  label: string;
  disabledAt: string | null;
  createdAt: string;
}

/**
 * What may appear in a URL we hand to the public.
 *
 * Lowercase letters, digits and internal hyphens, 2-40 characters. Narrow on
 * purpose: this string is read aloud, typed off a screenshot, and pasted into
 * places that mangle punctuation. It is also the thing an attacker controls if
 * they can guess a URL, so keeping the character set to the smallest set that
 * does the job removes a class of problems rather than escaping around it.
 *
 * The database CHECK constraint in migrations/0006 says the same thing. Both
 * exist because the CLI is not the only writer we will ever have.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

/**
 * A Discord invite code as it appears after `discord.gg/`.
 *
 * Discord's own codes are alphanumeric; vanity URLs additionally allow hyphens.
 * We validate rather than trust because this value ends up in a `Location`
 * header, and a header value is exactly where an unvalidated string becomes a
 * redirect to somewhere we did not choose.
 */
const INVITE_CODE = /^[A-Za-z0-9-]{1,64}$/;

export function isValidInviteCode(code: string): boolean {
  return INVITE_CODE.test(code);
}

/** The URL a click is sent on to. */
export function inviteUrl(code: string): string {
  return `https://discord.gg/${code}`;
}

/**
 * Reads and writes `invite_campaigns`.
 *
 * The lookup is cached in memory with a short TTL. A redirect is on the critical
 * path of a person deciding whether to join us, so it must not wait on a
 * database round trip that is answering the same question it answered a second
 * ago - and if Postgres is briefly unavailable, a cached campaign still
 * redirects. The TTL is short enough that adding a link is effectively instant.
 */
export class CampaignStore {
  private db: Db;
  private cache = new Map<string, { value: Campaign | null; expiresAt: number }>();
  private ttlMs: number;
  private negativeTtlMs: number;
  private now: () => number;

  constructor(db: Db, opts: { ttlMs?: number; negativeTtlMs?: number; now?: () => number } = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? 30_000;
    // Misses (404s) get a much shorter TTL than hits. The CLI runs in a
    // separate process whose add() can only invalidate its own in-memory
    // cache, so a miss cached at full TTL would keep 404ing a just-added
    // slug in the redirect process for up to 30s (TOG-9926). Clamped to the
    // hit TTL so ttlMs: 0 still means "no caching at all".
    this.negativeTtlMs = opts.negativeTtlMs ?? Math.min(2_000, this.ttlMs);
    this.now = opts.now ?? Date.now;
  }

  /** Null when there is no such slug. Disabled campaigns still resolve. */
  async lookup(slug: string): Promise<Campaign | null> {
    if (!isValidSlug(slug)) return null;

    const hit = this.cache.get(slug);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const row = await this.db
      .prepare(
        `SELECT slug, invite_code, label, disabled_at, created_at
           FROM invite_campaigns WHERE slug = ?`,
      )
      .get<{
        slug: string;
        invite_code: string;
        label: string;
        disabled_at: string | null;
        created_at: string;
      }>(slug);

    const value: Campaign | null = row
      ? {
          slug: row.slug,
          inviteCode: row.invite_code,
          label: row.label,
          disabledAt: row.disabled_at,
          createdAt: row.created_at,
        }
      : null;

    // Misses are cached too, but at a short negative TTL. Otherwise a bot
    // walking URLs turns every 404 into a database query, which is the
    // cheapest denial of service anyone could mount against us - while a
    // full-TTL miss would keep 404ing a just-added slug (the CLI runs in a
    // separate process) for up to 30s after --add (TOG-9926).
    const ttl = value === null ? this.negativeTtlMs : this.ttlMs;
    this.cache.set(slug, { value, expiresAt: this.now() + ttl });
    return value;
  }

  async list(): Promise<Campaign[]> {
    const rows = await this.db
      .prepare(
        `SELECT slug, invite_code, label, disabled_at, created_at
           FROM invite_campaigns ORDER BY slug`,
      )
      .all<{
        slug: string;
        invite_code: string;
        label: string;
        disabled_at: string | null;
        created_at: string;
      }>();
    return rows.map((r) => ({
      slug: r.slug,
      inviteCode: r.invite_code,
      label: r.label,
      disabledAt: r.disabled_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * Add a campaign. Refuses to overwrite an existing slug.
   *
   * Silently repointing a slug would rewrite history: clicks recorded yesterday
   * against the old code would be read as clicks for the new one, and the
   * per-place numbers this feature exists to produce would be wrong with no
   * trace of why. Retire the old one and add a new slug instead.
   */
  async add(c: { slug: string; inviteCode: string; label: string; createdAt: string }): Promise<void> {
    if (!isValidSlug(c.slug)) {
      throw new Error(
        `Invalid campaign slug "${c.slug}". Lowercase letters, digits and hyphens, 2-40 characters.`,
      );
    }
    if (!isValidInviteCode(c.inviteCode)) {
      throw new Error(
        `Invalid Discord invite code "${c.inviteCode}". Pass the code only, not the discord.gg/ URL.`,
      );
    }
    const r = await this.db
      .prepare(
        `INSERT INTO invite_campaigns (slug, invite_code, label, disabled_at, created_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT (slug) DO NOTHING`,
      )
      .run(c.slug, c.inviteCode, c.label, c.createdAt);
    if (r.changes === 0) {
      throw new Error(
        `Campaign "${c.slug}" already exists. Slugs are never repointed - retire it and add a new one.`,
      );
    }
    this.cache.delete(c.slug);
  }

  /** Stop listing a campaign as current. The link keeps redirecting. */
  async disable(slug: string, at: string): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE invite_campaigns SET disabled_at = ? WHERE slug = ? AND disabled_at IS NULL`)
      .run(at, slug);
    this.cache.delete(slug);
    return r.changes > 0;
  }
}

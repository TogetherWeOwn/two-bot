/**
 * go.two.gg - the tracked invite redirect (TOG-116).
 *
 * `GET /<campaign>` -> record an `invite_click` -> `302` to the Discord invite.
 * That is the whole service. It exists because Discord reports invite clicks to
 * nobody: a click only ever becomes visible to us as a use-count delta at join
 * time, which means the people who saw an invite and decided against it are
 * invisible. Those are exactly the people worth knowing about, because "nobody
 * sees our invite" and "everybody sees it and bounces" have opposite fixes.
 *
 * WHAT THIS BINDS TO, AND WHY IT IS NOT LIKE internal/server.ts
 *
 * The internal actions endpoint refuses to start on a public address, because
 * it is a remote control for the Discord server. This one is the opposite: it
 * is a public URL by definition - a link we hand to strangers - and it can do
 * exactly one thing, which is send someone to an invite that is already public.
 * It holds no Discord token and calls no Discord API. So it binds where it is
 * told, defaulting to loopback for the reverse proxy in front of it.
 *
 * WHAT IT DOES NOT COLLECT
 *
 * No cookies, no fingerprinting, no IP, no user agent, no referrer. A click row
 * is a campaign and a timestamp. This is not an incidental property of the
 * implementation, it is the requirement - see docs/PRIVACY.md - and
 * test/unit.redirect.test.ts asserts the recorded event carries nothing else.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { log } from '../core/log.ts';
import { TokenBuckets, type BucketSpec } from '../internal/rateLimit.ts';
import { CampaignStore, inviteUrl, isValidInviteCode } from './campaigns.ts';

/** What a click is recorded through. Kept to the one method we need. */
export interface ClickRecorder {
  onInviteClick(
    guildId: string,
    code: string,
    opts: { occurredAt?: string; campaign?: string; dedupeToken?: string },
  ): Promise<unknown>;
}

export interface RedirectServerOptions {
  host: string;
  port: number;
  guildId: string;
  campaigns: CampaignStore;
  recorder: ClickRecorder;
  /**
   * Where `/` goes. The bare domain is going to be typed and pasted by people
   * who dropped the path, and a 404 there is a lost member for no reason.
   */
  fallbackInviteCode?: string | null;
  bucket?: BucketSpec;
  now?: () => number;
}

export interface RedirectServer {
  port: number;
  url: string;
  close(): Promise<void>;
  /**
   * Resolves when every click write started so far has finished.
   *
   * "Redirect first, record after" means the 302 reaches the caller while the
   * insert is still in flight, so there is a window where the response has
   * arrived and the row does not exist yet. That is correct in production - the
   * person is not made to wait on a database - but it makes "click, then read
   * the row back" a race for anything driving this over real HTTP because the
   * Postgres write is a separate round trip.
   *
   * `close()` awaits this too, so a SIGTERM does not drop clicks that were
   * already redirected.
   */
  drain(): Promise<void>;
}

/**
 * Per-IP, and generous: 60 requests with a burst of 60.
 *
 * This is not abuse prevention - it cannot be, since the whole service is one
 * public GET. It is a cap on how badly one broken crawler can inflate the click
 * count, which matters because that count is a number the company steers on.
 * A human clicking a link never comes close.
 */
const CLICK_BUCKET: BucketSpec = { capacity: 60, refillPerSecond: 1 };

export async function startRedirectServer(opts: RedirectServerOptions): Promise<RedirectServer> {
  const buckets = new TokenBuckets({ now: opts.now });
  const bucket = opts.bucket ?? CLICK_BUCKET;

  // Click writes outlive the response they belong to (see `drain`). Held so
  // shutdown - and tests - can wait for them instead of guessing.
  const inFlight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };
  const drain = async (): Promise<void> => {
    // A settling write cannot start another, but it can still be added between
    // the snapshot and the await, so loop until the set is genuinely empty.
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  const server: Server = createServer((req, res) => {
    track(handle(req, res, opts, buckets, bucket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  log.info('invite_redirect_listening', {
    host: opts.host,
    port: addr.port,
    guildId: opts.guildId,
    fallback: opts.fallbackInviteCode ?? null,
  });

  return {
    port: addr.port,
    url: `http://${opts.host}:${addr.port}/`,
    drain,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      // After the socket is shut, not before: a click already redirected still
      // deserves to be counted.
      await drain();
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RedirectServerOptions,
  buckets: TokenBuckets,
  bucket: BucketSpec,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  // Query strings are dropped, not parsed. Campaign trackers append ?fbclid=...
  // and friends, and we want no part of them: they are the identifying data
  // this service promises not to collect.
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }

  // Browsers ask for this unprompted on every navigation. Answering 404 without
  // touching the database keeps favicon requests out of the click count.
  if (path === '/favicon.ico' || path === '/robots.txt') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return;
  }

  // Per-caller cap, applied before the database is touched so a crawler cannot
  // turn a URL walk into load. The address is read from the open socket, used
  // to pick a bucket, and never stored, logged or written to an event - it does
  // not survive this function. See docs/PRIVACY.md.
  const caller = req.socket.remoteAddress ?? 'unknown';
  if (!buckets.take(caller, bucket).allowed) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' }).end('slow down\n');
    return;
  }

  let slug: string;
  try {
    slug = decodeURIComponent(path.replace(/^\/+/, '').replace(/\/+$/, '')).toLowerCase();
  } catch (err) {
    // A malformed percent-escape throws. That is a 404, not a 500 — but it is
    // still logged with the raw path and the error class, because a sudden
    // burst of these is a broken referrer (or a prober) worth knowing about.
    // The raw path is the requested campaign slot, not visitor data: no IP,
    // agent, cookie or referrer is read here (see docs/PRIVACY.md).
    log.error('invite_redirect_decode_failed', { path, errorClass: errorClassOf(err) });
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return;
  }

  // The bare domain. Redirect without recording a click: nobody clicked a
  // tracked link, and counting it would put clicks in the numerator that no
  // campaign can be credited for.
  if (slug === '') {
    if (opts.fallbackInviteCode && isValidInviteCode(opts.fallbackInviteCode)) {
      redirect(res, inviteUrl(opts.fallbackInviteCode));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return;
  }

  const campaign = await opts.campaigns.lookup(slug).catch((err: unknown) => {
    log.error('invite_redirect_lookup_failed', { slug, errorClass: errorClassOf(err), err: String(err) });
    return undefined;
  });

  // undefined means the database is unreachable; null means no such slug. The
  // difference matters: an outage must not turn a live link into a 404 that a
  // crawler caches, so we send them to the invite anyway when we have a
  // fallback and lose only the measurement.
  if (campaign === undefined) {
    if (opts.fallbackInviteCode && isValidInviteCode(opts.fallbackInviteCode)) {
      redirect(res, inviteUrl(opts.fallbackInviteCode));
      return;
    }
    res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' }).end('temporarily unavailable\n');
    return;
  }

  if (campaign === null) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return;
  }

  if (!isValidInviteCode(campaign.inviteCode)) {
    // Nothing legitimate writes a code this bad; refuse rather than put it in a
    // Location header.
    log.error('invite_redirect_bad_code', { slug, code: campaign.inviteCode });
    res.writeHead(500, { 'content-type': 'text/plain' }).end('misconfigured campaign\n');
    return;
  }

  const target = inviteUrl(campaign.inviteCode);

  // Redirect FIRST, record after. The person is why we are here; the
  // measurement is not worth making them wait on a database write, and it is
  // certainly not worth a failed write costing us a member.
  redirect(res, target);

  // HEAD is how link previewers and uptime checks ask. Not a person, not a
  // click. Discord itself HEADs a URL when someone pastes it in a channel, so
  // counting these would inflate every campaign the moment it is shared.
  if (req.method === 'HEAD') return;

  try {
    await opts.recorder.onInviteClick(opts.guildId, campaign.inviteCode, {
      campaign: campaign.slug,
      // Random per request. Two people clicking in the same millisecond are two
      // clicks; without this they share an idempotency key and the second is
      // dropped as a duplicate. Not derived from anything about the visitor.
      dedupeToken: randomUUID(),
    });
  } catch (err) {
    // A lost click is a slightly low number. A crash here would take down the
    // redirect for everyone, which is a lost member.
    log.error('invite_click_record_failed', { slug, err: String(err) });
  }
}

/**
 * The constructor name of whatever was thrown, for log lines.
 *
 * `String(err)` keeps the message; this keeps the class, which is what tells
 * a dead database (a driver `Error`) apart from a coding bug (`TypeError`) at
 * 3am. Non-Error throws report their typeof instead of `undefined`.
 */
function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 120) : typeof err;
}

function redirect(res: ServerResponse, location: string): void {
  // 302, not 301. A permanent redirect is cached by browsers and intermediaries
  // forever, which means the second click from that person never reaches us and
  // the campaign silently stops counting. no-store says the same thing to
  // anything that ignores the status code.
  res.writeHead(302, {
    location,
    'cache-control': 'no-store, no-cache, must-revalidate',
    // Do not leak our own URL - and therefore the campaign - to Discord.
    'referrer-policy': 'no-referrer',
    'content-type': 'text/plain',
  });
  res.end(`redirecting to ${location}\n`);
}

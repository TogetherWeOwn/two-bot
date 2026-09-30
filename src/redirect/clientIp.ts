/**
 * Who is calling the redirect, for rate-limit bucketing only (TOG-9924).
 *
 * `src/redirect/server.ts` used to key its per-caller TokenBuckets bucket on
 * `req.socket.remoteAddress`. Behind the reverse proxy that terminates TLS for
 * go.two.gg every request arrives on one socket IP, so one crawler burned the
 * shared bucket and every real visitor 429d. Reading X-Forwarded-For naively
 * would fix that by letting any client self-exempt with a spoofed header, so
 * the header is only believed when the socket itself belongs to a configured
 * trusted proxy, and then only the leftmost untrusted hop in the chain.
 *
 * The resolved address picks a bucket and never leaves the request handler -
 * it is not stored, logged or written to any event (docs/PRIVACY.md). Nothing
 * here touches the database.
 */
import { BlockList, isIP } from 'node:net';

/** Loopback only. The default deployment is proxy-on-the-same-box. */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ['127.0.0.0/8', '::1/128'];

/**
 * Validate a comma-separated allowlist of IPs and CIDRs
 * (`TWO_REDIRECT_TRUSTED_PROXIES`). Returns the entries normalized for
 * `createTrustedProxyChecker`. Throws naming the bad entry - config mistakes
 * must fail at startup, not silently trust nobody (or everybody).
 */
export function parseTrustedProxyList(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      if (isIP(entry) === 0) {
        throw new Error(
          `entry "${entry}" is not an IP address - use 203.0.113.7 or 203.0.113.0/24 form`,
        );
      }
      continue;
    }
    const addr = entry.slice(0, slash);
    const prefix = entry.slice(slash + 1);
    const family = isIP(addr);
    if (family === 0) {
      throw new Error(`entry "${entry}" is not an IP/CIDR pair - "${addr}" is not an IP address`);
    }
    const max = family === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefix) || Number(prefix) > max) {
      throw new Error(`entry "${entry}" has a bad prefix - expected 0-${max} for IPv${family}`);
    }
  }
  return entries;
}

/** `::ffff:127.0.0.1` -> `127.0.0.1`, so mapped loopback matches a v4 list. */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return (mapped?.[1] ?? trimmed).toLowerCase();
}

/** A predicate over the allowlist. Unknown strings are untrusted, never an error. */
export function createTrustedProxyChecker(entries: readonly string[]): (ip: string) => boolean {
  const v4 = new BlockList();
  const v6 = new BlockList();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      const family = isIP(entry);
      if (family === 4) v4.addAddress(entry, 'ipv4');
      else if (family === 6) v6.addAddress(entry, 'ipv6');
      continue;
    }
    const addr = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    const family = isIP(addr);
    if (family === 4) v4.addSubnet(addr, prefix, 'ipv4');
    else if (family === 6) v6.addSubnet(addr, prefix, 'ipv6');
  }
  return (ip: string) => {
    const normalized = normalizeIp(ip);
    const family = isIP(normalized);
    if (family === 4) return v4.check(normalized, 'ipv4');
    if (family === 6) return v6.check(normalized, 'ipv6');
    return false;
  };
}

/**
 * The address whose bucket a request counts against.
 *
 * - Socket not in the trusted set: the X-Forwarded-For header is ignored
 *   entirely and the socket address is returned. A client talking to us
 *   directly cannot self-exempt by spoofing the header.
 * - Socket trusted: the header is a chain `client, proxy1, proxy2` with our
 *   proxy appending the rightmost entry, so walk right-to-left past trusted
 *   hops and return the first untrusted one. Entries that are not IPs are
 *   skipped, never trusted.
 * - Every hop trusted (or no header): the leftmost claim is the best answer
 *   we have; with a single trusted proxy that is exactly the client IP it saw.
 */
export function resolveClientIp(
  socketIp: string | undefined,
  xForwardedFor: string | string[] | undefined,
  isTrustedProxy: (ip: string) => boolean,
): string {
  const socket = socketIp?.trim() ? normalizeIp(socketIp) : 'unknown';
  if (!isTrustedProxy(socket)) return socket;
  const raw = Array.isArray(xForwardedFor) ? xForwardedFor.join(',') : (xForwardedFor ?? '');
  const chain = raw
    .split(',')
    .map((s) => normalizeIp(s))
    .filter((s) => s.length > 0 && isIP(s) !== 0);
  const hops = [...chain, socket];
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!isTrustedProxy(hop)) return hop;
  }
  return chain[0] ?? socket;
}

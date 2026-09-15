/**
 * The private-interface guard. docs/INTERNAL_ACTIONS.md §1.
 *
 * "If the bot process finds itself listening on a public address at startup it
 * refuses to start - a config mistake should be a crash, not a quietly-exposed
 * remote control."
 *
 * There is deliberately no override flag. An escape hatch here would be used
 * once at 2am to make an error go away, and then we would have a remote
 * control for the Discord server on the public internet.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

interface BindAddress {
  address: string;
  family: number;
}

export type BindLookup = (host: string) => Promise<BindAddress[]>;

/** Loopback, RFC1918, CGNAT, link-local, and IPv6 loopback / unique-local. */
export function isPrivateAddress(addr: string): boolean {
  const host = normalise(addr);

  if (host === '::1') return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7
  if (host.startsWith('fe80:')) return true; // link-local

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  return false;
}

/** Strip an IPv6 zone and the ::ffff: prefix Node uses for mapped v4. */
function normalise(addr: string): string {
  let host = addr.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  return host;
}

/**
 * Throw unless `host` is a specific private address.
 *
 * The wildcards are rejected by name because they are the actual mistake we
 * are guarding against: 0.0.0.0 looks local in a config file and is not.
 */
export function assertPrivateBind(host: string): void {
  const h = normalise(host);
  if (h === '' || h === '0.0.0.0' || h === '::' || h === '*') {
    throw new Error(
      `Refusing to start the internal actions endpoint on the wildcard address "${host}". ` +
        'Bind it to a specific private address (127.0.0.1 or the private NIC). ' +
        'See docs/INTERNAL_ACTIONS.md §1.',
    );
  }
  if (!isPrivateAddress(h)) {
    throw new Error(
      `Refusing to start the internal actions endpoint on the public address "${host}". ` +
        'This endpoint is a remote control for the Discord server and must never be ' +
        'reachable from the internet. See docs/INTERNAL_ACTIONS.md §1.',
    );
  }
}

/** Resolve a private DNS name once, then bind the exact address we validated. */
export async function resolvePrivateBindHost(
  host: string,
  resolve: BindLookup = (name) => lookup(name, { all: true, verbatim: true }),
): Promise<string> {
  const h = normalise(host);
  if (isIP(h)) {
    assertPrivateBind(h);
    return h;
  }
  // Keep the wildcard error distinct before asking DNS about an empty or magic name.
  if (h === '' || h === '*') assertPrivateBind(h);

  let addresses: BindAddress[];
  try {
    addresses = await resolve(h);
  } catch (error) {
    throw new Error(
      `Refusing to start the internal actions endpoint because bind host "${host}" could not be resolved. ` +
        'A DNS failure must not weaken the private-interface guard.',
      { cause: error },
    );
  }

  if (addresses.length === 0) {
    throw new Error(`Refusing to start the internal actions endpoint because bind host "${host}" resolved to no addresses.`);
  }
  for (const { address } of addresses) assertPrivateBind(address);
  return normalise(addresses[0].address);
}

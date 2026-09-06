export interface JoinPathObservation {
  works: boolean;
  detail: string;
}

export interface ObserveJoinPathOptions {
  fetch?: typeof fetch;
  maxRedirects?: number;
  homepageHtml?: string;
}

const JOIN_LINK = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*\bdata-testid\s*=\s*(["'])discord-join\3[^>]*>|<a\b[^>]*\bdata-testid\s*=\s*(["'])discord-join\4[^>]*\bhref\s*=\s*(["'])([^"']+)\5[^>]*>/i;

export function trackedJoinPathFromHtml(site: string, html: string): URL | undefined {
  const match = html.match(JOIN_LINK);
  const href = match?.[2] ?? match?.[6];
  if (!href) return undefined;

  const url = new URL(href, site);
  return url.origin === new URL(site).origin ? url : undefined;
}

function sameDestination(actual: URL, expected: URL): boolean {
  return (
    actual.protocol === expected.protocol &&
    actual.hostname.toLowerCase() === expected.hostname.toLowerCase() &&
    actual.port === expected.port &&
    actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') &&
    actual.search === expected.search
  );
}

function step(status: number, from: URL, to: URL): string {
  return `${status} ${from.href} -> ${to.href}`;
}

/**
 * Exercise the public join route without following the final Discord redirect.
 * Reaching the expected Location proves the website path is wired while stopping
 * before Discord can render or accept an invite.
 */
export async function observeTrackedJoinPath(
  site: string,
  expectedDestination: string,
  options: ObserveJoinPathOptions = {},
): Promise<JoinPathObservation> {
  const request = options.fetch ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const expected = new URL(expectedDestination);
  const tracked = options.homepageHtml ? trackedJoinPathFromHtml(site, options.homepageHtml) : undefined;
  if (options.homepageHtml && !tracked) {
    return {
      works: false,
      detail: 'the Phase 1 homepage did not render its tracked Discord join link.',
    };
  }

  let current = tracked ?? new URL('/join', site);
  const websiteOrigin = new URL(site).origin;
  const steps: string[] = [];

  for (let redirects = 0; redirects < maxRedirects; redirects += 1) {
    let response: Response;
    try {
      response = await request(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
    } catch (err) {
      return {
        works: false,
        detail: `${current.href} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return {
        works: false,
        detail: `${current.href} answered ${response.status} without a redirect to ${expected.href}.`,
      };
    }

    const next = new URL(location, current);
    steps.push(step(response.status, current, next));

    if (sameDestination(next, expected)) {
      return {
        works: true,
        detail: `the tracked join path reached the expected invite without opening Discord: ${steps.join('; ')}.`,
      };
    }

    if (next.origin !== websiteOrigin) {
      return {
        works: false,
        detail: `the tracked join path left the website for the wrong destination: ${steps.join('; ')} (expected ${expected.href}).`,
      };
    }

    current = next;
  }

  return {
    works: false,
    detail: `the tracked join path exceeded ${maxRedirects} website redirects before reaching ${expected.href}: ${steps.join('; ')}.`,
  };
}

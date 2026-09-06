export interface JoinPathObservation {
  works: boolean;
  detail: string;
}

export interface ObserveJoinPathOptions {
  fetch?: typeof fetch;
  homepageHtml?: string;
}

export interface ObserveApprovedSiteOptions {
  fetch?: typeof fetch;
}

export interface ApprovedSiteObservation {
  live: boolean;
  detail: string;
  site?: string;
  homepageHtml?: string;
}

const JOIN_LINK = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*\bdata-testid\s*=\s*(["'])discord-join\3[^>]*>|<a\b[^>]*\bdata-testid\s*=\s*(["'])discord-join\4[^>]*\bhref\s*=\s*(["'])([^"']+)\5[^>]*>/i;
const JOIN_INTERSTITIAL = /\bdata-testid\s*=\s*(["'])one-click-join\1/i;

const APPROVED_SITE = new URL('https://togetherweown.com/');

function sameDestination(actual: URL, expected: URL): boolean {
  return (
    actual.protocol === expected.protocol &&
    actual.hostname.toLowerCase() === expected.hostname.toLowerCase() &&
    actual.port === expected.port &&
    actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') &&
    actual.search === expected.search
  );
}

export function trackedJoinPathFromHtml(site: string, html: string): URL | undefined {
  const match = html.match(JOIN_LINK);
  const href = match?.[2] ?? match?.[6];
  if (!href) return undefined;

  const url = new URL(href, site);
  const expected = new URL('/join', site);
  return sameDestination(url, expected) ? url : undefined;
}

export async function observeApprovedPublicSite(
  vanitySite: string,
  options: ObserveApprovedSiteOptions = {},
): Promise<ApprovedSiteObservation> {
  const request = options.fetch ?? fetch;
  const vanity = new URL(vanitySite);
  let response: Response;

  try {
    response = await request(vanity, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return {
      live: false,
      detail: `${vanity.href} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    return {
      live: false,
      detail: `${vanity.href} answered ${response.status} instead of redirecting to ${APPROVED_SITE.href}.`,
    };
  }

  const publicSite = new URL(location, vanity);
  if (!sameDestination(publicSite, APPROVED_SITE)) {
    return {
      live: false,
      detail: `${vanity.href} redirected to ${publicSite.href}, not the approved public site ${APPROVED_SITE.href}.`,
    };
  }

  try {
    response = await request(publicSite, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return {
      live: false,
      detail: `${publicSite.href} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok || (response.url && !sameDestination(new URL(response.url), publicSite))) {
    return {
      live: false,
      detail: `${publicSite.href} returned ${response.status} instead of serving Phase 1 on the approved hostname.`,
    };
  }

  return {
    live: true,
    detail: `${vanity.href} redirects to ${publicSite.href}, which answers ${response.status} with Phase 1.`,
    site: publicSite.href,
    homepageHtml: await response.text(),
  };
}

/**
 * Exercise the approved Phase 1 route without following the final Discord
 * redirect. The tracked homepage link intentionally opens a 200 interstitial;
 * /discord is the separate route that must expose the exact invite Location.
 */
export async function observeTrackedJoinPath(
  site: string,
  expectedDestination: string,
  options: ObserveJoinPathOptions = {},
): Promise<JoinPathObservation> {
  const request = options.fetch ?? fetch;
  const expected = new URL(expectedDestination);
  const tracked = options.homepageHtml ? trackedJoinPathFromHtml(site, options.homepageHtml) : undefined;
  if (options.homepageHtml && !tracked) {
    return {
      works: false,
      detail: 'the Phase 1 homepage did not render its tracked /join link.',
    };
  }

  const join = tracked ?? new URL('/join', site);
  let response: Response;

  try {
    response = await request(join, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return {
      works: false,
      detail: `${join.href} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status !== 200 || response.headers.has('location')) {
    return {
      works: false,
      detail: `${join.href} answered ${response.status} instead of serving the approved 200 interstitial.`,
    };
  }

  const joinHtml = await response.text();
  if (!JOIN_INTERSTITIAL.test(joinHtml)) {
    return {
      works: false,
      detail: `${join.href} answered 200 without the approved join interstitial.`,
    };
  }

  const discord = new URL('/discord', site);
  try {
    response = await request(discord, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return {
      works: false,
      detail: `${discord.href} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    return {
      works: false,
      detail: `${discord.href} answered ${response.status} without a redirect to ${expected.href}.`,
    };
  }

  const destination = new URL(location, discord);
  if (!sameDestination(destination, expected)) {
    return {
      works: false,
      detail: `${discord.href} redirected to the wrong destination ${destination.href} (expected ${expected.href}).`,
    };
  }

  return {
    works: true,
    detail: `${join.href} served the approved 200 interstitial; ${discord.href} redirected to the exact expected invite without opening Discord.`,
  };
}

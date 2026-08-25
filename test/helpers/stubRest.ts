import { DiscordRest } from '../../src/discord/rest.ts';

/** A DiscordRest wired to a JSON stub, recording every path it was asked for. */
export function stubRest(handler: (path: string) => unknown) {
  const paths: string[] = [];
  const rest = new DiscordRest({
    token: 'test-token',
    base: 'https://discord.test/api/v10',
    minIntervalMs: 0,
    fetchImpl: (async (url: string) => {
      const path = String(url).replace('https://discord.test/api/v10', '');
      paths.push(path);
      const body = handler(path);
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  return { rest, paths };
}

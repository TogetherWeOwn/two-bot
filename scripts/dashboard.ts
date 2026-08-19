/**
 * Build the weekly growth dashboard.
 *
 *   npm run dashboard                 # write data/dashboard.html
 *   npm run dashboard -- --json       # print the raw numbers instead
 *   npm run dashboard -- --serve      # rebuild on every request, port 8080
 *   npm run dashboard -- --weeks 26   # more history
 *
 * Reads the same database the bot writes to (TWO_DATABASE_URL, or TWO_DB_PATH,
 * or ./data/two.db) - so if this page is wrong, the bot is wrong, and there is
 * no third place the truth could be hiding.
 *
 * --serve exists so the page can be a URL rather than a file somebody has to
 * remember to re-download. It binds to localhost by default; put it behind the
 * same reverse proxy as anything else on the host if it needs to be reachable.
 * It serves one page, read-only, with no query parameters that reach the
 * database.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openDb } from '../src/store/db.ts';
import { buildDashboard, type ChannelSnapshot } from '../src/analytics/dashboard.ts';
import { renderHtml } from '../src/analytics/render.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';
const weeks = Number(value('weeks', '12'));
const outPath = value('out', './data/dashboard.html');
const dataDir = process.env.TWO_DATA_DIR || './data';

/**
 * The newest server-audit-*.json in the data directory. That file is the only
 * place real per-channel message counts exist - the funnel log records that a
 * member first spoke, not how busy a room is. Missing is fine; the dashboard
 * says so on the page rather than showing a blank table.
 */
async function loadChannelSnapshot(): Promise<ChannelSnapshot | null> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch {
    return null;
  }
  const candidates = names.filter((n) => /^server-audit-.*\.json$/.test(n)).sort();
  const newest = candidates.at(-1);
  if (!newest) return null;
  try {
    const raw = JSON.parse(await readFile(join(dataDir, newest), 'utf8'));
    if (!Array.isArray(raw?.channels)) return null;
    // audit-collect nests the measured numbers under `audit` and leaves the raw
    // Discord object at the top level. Flatten, so the dashboard never has to
    // know which shape it got.
    const channels = raw.channels.map((c: Record<string, any>) => {
      const a = (c.audit ?? c) as Record<string, any>;
      return {
        id: String(c.id ?? a.channel_id ?? ''),
        name: String(c.name ?? a.name ?? ''),
        parent_name: c.parent_name ?? a.category ?? null,
        human_msgs_30d: a.human_msgs_30d,
        human_msgs_90d: a.human_msgs_90d,
        unique_humans_30d: a.unique_humans_30d,
        last_message_at: a.last_message_at,
        days_silent: a.days_silent,
      };
    });
    return { collected_at: String(raw.collected_at ?? ''), channels };
  } catch (err) {
    console.warn(`could not read channel snapshot ${newest}: ${String(err)}`);
    return null;
  }
}

async function build() {
  const db = await openDb(dbSpec, { applicationName: 'two-bot-dashboard' });
  try {
    return await buildDashboard(db, { weeks, channelSnapshot: await loadChannelSnapshot() });
  } finally {
    await db.close();
  }
}

if (flag('serve')) {
  const port = Number(value('port', process.env.PORT ?? '8080'));
  const host = value('host', '127.0.0.1');
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '/index.html' && path !== '/dashboard.json') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    try {
      const data = await build();
      if (path === '/dashboard.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data, null, 2));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderHtml(data));
    } catch (err) {
      // Never render a half-built page: a dashboard that shows stale or partial
      // numbers without saying so is worse than one that is plainly down.
      console.error(err);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('dashboard failed to build - check the bot host logs\n');
    }
  });
  server.listen(port, host, () => {
    console.log(`TWO dashboard on http://${host}:${port}/  (json at /dashboard.json)`);
  });
} else {
  const data = await build();
  if (flag('json')) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, renderHtml(data), 'utf8');
    console.log(`wrote ${outPath}`);
    console.log(
      `  joined this week ${data.thisWeek.joins} · active last 7 days ${data.active7d} · ` +
        `real members ${data.realHumans}`,
    );
  }
}

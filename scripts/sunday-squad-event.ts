/**
 * Create (or repair) the recurring Sunday Squad scheduled event. TOG-93 item 2,
 * spec in TWO-66 §5.4 revision 4.
 *
 *   node scripts/sunday-squad-event.ts --dry-run        # no token needed
 *   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/sunday-squad-event.ts
 *   ... node scripts/sunday-squad-event.ts --individual # six one-off cards
 *
 * Idempotent. It looks for an existing event with the same name first and
 * PATCHes it rather than adding a second card, because two Sunday Squads in the
 * sidebar is worse than none - people pick the wrong one and then do not come.
 *
 * --dry-run prints the exact request bodies and exits 0 without a token. That
 * is the mode that is useful before the bot has credentials: the payload can be
 * read and signed off in review, and the only thing left to trust afterwards is
 * the HTTP call itself.
 *
 * --individual is the escape hatch the CM asked for: Discord refuses
 * `recurrence_rule` on some guilds, and six real cards topped up by hand beat
 * one recurring card silently anchored on the wrong week.
 */
import {
  SUNDAY_SQUAD,
  individualEventPayloads,
  liveSeriesStartEpoch,
  scheduledEventPayload,
} from '../src/onboarding/anchorEvent.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/sunday-squad-event.ts [--dry-run] [--individual]');
  process.exit(0);
}

const API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const individual = args.has('--individual');

const now = Date.now();
const bodies = individual
  ? individualEventPayloads(now, 6)
  : [scheduledEventPayload(SUNDAY_SQUAD, liveSeriesStartEpoch(now))];

if (dryRun) {
  console.log(`# ${individual ? bodies.length : 1} request(s) that would be sent to Discord\n`);
  for (const b of bodies) {
    console.log(`POST /guilds/{guild}/scheduled-events`);
    console.log(JSON.stringify(b, null, 2));
    console.log();
  }
  console.log('dry run: nothing was sent.');
  process.exit(0);
}

if (!TOKEN || !GUILD) {
  console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN) and DISCORD_GUILD_ID, or --dry-run');
  process.exit(2);
}

const auth = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };

interface ExistingEvent {
  id: string;
  name: string;
  scheduled_start_time: string;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const listRes = await call('GET', `/guilds/${GUILD}/scheduled-events`);
if (!listRes.ok) {
  console.error(`could not list scheduled events: ${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const existing = ((await listRes.json()) as ExistingEvent[]).filter(
  (e) => e.name === SUNDAY_SQUAD.name,
);

let failed = 0;
for (const body of bodies) {
  // Match on start time for --individual so re-running tops the series up
  // rather than duplicating the weeks that are already there.
  const match = individual
    ? existing.find((e) => e.scheduled_start_time === body.scheduled_start_time)
    : existing[0];

  const res = match
    ? await call('PATCH', `/guilds/${GUILD}/scheduled-events/${match.id}`, body)
    : await call('POST', `/guilds/${GUILD}/scheduled-events`, body);

  if (res.ok) {
    const saved = (await res.json()) as ExistingEvent;
    console.log(`  ${match ? 'UPDATED' : 'CREATED'}  ${saved.name}  ${saved.scheduled_start_time}  (${saved.id})`);
    continue;
  }

  const detail = await res.text();
  failed++;
  console.error(`  FAILED   ${body.scheduled_start_time}: ${res.status} ${detail}`);
  // The specific failure worth naming, because the remedy is a different flag
  // and not a retry.
  if (!individual && detail.includes('recurrence_rule')) {
    console.error('  -> this guild refused the recurrence rule. Re-run with --individual.');
  }
}

if (existing.length > 1 && !individual) {
  console.error(
    `\n  WARNING  ${existing.length} events named "${SUNDAY_SQUAD.name}" exist. Only the first was updated; delete the rest by hand.`,
  );
}

process.exit(failed ? 1 : 0);

/**
 * Rules-gate conversion: how many arrivals ever become people who can talk.
 * READ-ONLY.
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/gate-report.ts
 *   node scripts/gate-report.ts --months 6     # cohort table depth, default 14
 *
 * TESTING. The roster read honors DISCORD_API_BASE (default
 * https://discord.com/api/v10) so test/e2e.gatereport.test.ts can point it at
 * a loopback stub. Production never sets it.
 *
 * WHY THIS EXISTS
 *
 * The server runs Discord membership screening, so a new arrival lands with
 * `pending: true` and cannot type, react or click anything until they accept
 * the rules. Onboarding (TWO-7) deliberately waits for that flag to clear
 * before it says a word, because welcoming someone who physically cannot
 * respond is worse than silence.
 *
 * The consequence is that the gate sets a hard ceiling on everything
 * downstream. A member who never clears it is never welcomed, never picks a
 * game, never gets routed, and never shows up in any funnel number after
 * `member_join`. They sit in the member count looking like a member.
 *
 * Nothing was measuring that ceiling, so this does. It reads the live roster
 * and prints the one number that bounds every other onboarding number.
 *
 * WHAT IT DOES NOT DO
 *
 * It cannot see people who hit the gate, gave up, and left - they are not on
 * the roster any more, so every rate here is an upper bound on the true one.
 * It changes nothing, messages nobody, and stores nothing: display names are
 * never fetched and only snowflakes are ever printed. See docs/PRIVACY.md.
 */
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/gate-report.ts [--months <count>]');
  process.exit(0);
}

const API = process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !GUILD) {
  console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN) and DISCORD_GUILD_ID');
  process.exit(2);
}

const argv = process.argv.slice(2);
const monthsFlag = argv.indexOf('--months');
const MONTHS = monthsFlag === -1 ? 14 : Number(argv[monthsFlag + 1]);

interface Member {
  user: { id: string; bot?: boolean };
  joined_at: string;
  pending?: boolean;
  roles: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Paginate the roster. Needs the SERVER MEMBERS privileged intent. */
async function roster(): Promise<Member[]> {
  const all: Member[] = [];
  let after = '0';
  for (;;) {
    const page = await get<Member[]>(`/guilds/${GUILD}/members?limit=1000&after=${after}`);
    if (!page.length) break;
    all.push(...page);
    after = page[page.length - 1].user.id;
    if (page.length < 1000) break;
  }
  return all;
}

const all = await roster();
const humans = all.filter((m) => !m.user.bot);
const stuck = humans.filter((m) => m.pending === true);

const pct = (n: number, d: number) => (d === 0 ? '  -  ' : `${Math.round((n / d) * 100)}%`.padStart(5));

console.log('Rules-gate conversion - live read, nothing changed\n');
console.log(`  roster            ${all.length} (${humans.length} human, ${all.length - humans.length} bots)`);
console.log(`  cleared the gate  ${humans.length - stuck.length}`);
console.log(`  stuck at the gate ${stuck.length}   <- cannot type, react or click. Never onboarded.`);
console.log(`  gate conversion   ${pct(humans.length - stuck.length, humans.length).trim()} of humans on the roster today\n`);

if (humans.length === 0) {
  // An empty roster is "nobody to convert", not a zero-percent conversion:
  // the cohort table would print a bare header and the quiet-days line would
  // count from the epoch. Say so and stop.
  console.log('  no humans on the roster - no cohorts, no arrival rate, nothing to convert.\n');
  console.log(`Ceiling: onboarding can only ever reach the 0 members who cleared the gate.`);
  console.log('Members who hit the gate and left are not on the roster, so these rates are upper bounds.');
  process.exit(0);
}

// Cohort table. The gate is bursty rather than a steady leak, and a single
// blended percentage hides that completely.
const months = new Map<string, { total: number; stuck: number }>();
for (const m of humans) {
  const key = m.joined_at.slice(0, 7);
  const row = months.get(key) ?? { total: 0, stuck: 0 };
  row.total++;
  if (m.pending === true) row.stuck++;
  months.set(key, row);
}

const keys = [...months.keys()].sort().slice(-MONTHS);
console.log(`By join month (last ${keys.length} months with arrivals)\n`);
console.log('  month     joined  cleared  stuck  cleared%');
for (const k of keys) {
  const r = months.get(k)!;
  const cleared = r.total - r.stuck;
  // Flag the cohorts that stalled, not every month with a single straggler.
  const bar = r.stuck > 0 && cleared / r.total < 0.5 ? '  <- cohort stalled at the gate' : '';
  console.log(
    `  ${k}   ${String(r.total).padStart(5)}  ${String(cleared).padStart(7)}  ${String(r.stuck).padStart(5)}  ${pct(cleared, r.total)}${bar}`,
  );
}

// Recent arrival rate. This is the input to every growth number we have; if it
// is near zero, no amount of onboarding polish moves the metric.
const now = Date.now();
console.log('\nArrival rate (members still on the roster)\n');
for (const days of [7, 30, 90, 365]) {
  const since = now - days * 86_400_000;
  const cohort = humans.filter((m) => new Date(m.joined_at).getTime() >= since);
  const cleared = cohort.filter((m) => m.pending !== true).length;
  console.log(
    `  last ${String(days).padStart(3)} days   ${String(cohort.length).padStart(3)} joined   ${String(cleared).padStart(3)} cleared the gate`,
  );
}

const newest = humans
  .map((m) => new Date(m.joined_at).getTime())
  .reduce((a, b) => Math.max(a, b), 0);
const quietDays = Math.floor((now - newest) / 86_400_000);
console.log(`\n  most recent human join was ${quietDays} days ago.`);

console.log(
  `\nCeiling: onboarding can only ever reach the ${humans.length - stuck.length} members who cleared the gate.`,
);
console.log('Members who hit the gate and left are not on the roster, so these rates are upper bounds.');

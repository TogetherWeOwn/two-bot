/**
 * Answer one question about two scheduled-event snapshots: does the live guild
 * still match what the agent recorded, and if not, on which events and fields.
 *
 *   node scripts/scheduled-events-drift.ts <agent.json> <live.json>
 *   node scripts/scheduled-events-drift.ts --selftest
 *
 * Modeled on `scripts/live-cleanup-drift-diff.ts`: two captured JSON snapshots,
 * field-by-field diff, exit 0 means in sync, exit 1 names the drift. The two
 * sides are:
 *
 *   agent.json — what the bot last recorded. Export from the poller table, e.g.
 *     SELECT event_id, name, starts_at, channel_id, description, status
 *     FROM scheduled_events WHERE guild_id = '<guild>';
 *     (as a JSON array; `src/jobs/scheduledEvents.ts` owns that table).
 *   live.json — a fresh capture of the guild, e.g.
 *     curl -H "Authorization: Bot $DISCORD_TOKEN" \
 *       https://discord.com/api/v10/guilds/<guild>/scheduled-events
 *     (raw Discord shape; `scheduled_start_time` + numeric `status`).
 *
 * Both shapes are accepted on either side: `id`/`event_id`, `name`,
 * `scheduled_start_time`/`starts_at`, `channel_id`, `description`, and
 * `status` as a Discord number (1-4) or a stored string
 * (scheduled|active|completed|cancelled) are all normalized before compare, so
 * a DB export and a raw API capture can be diffed directly.
 *
 * Read-only: no network, no Discord token, no database, no writes. `--help`
 * and `--selftest` read nothing from disk.
 */

import { readFileSync } from 'node:fs';

export type EventStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

export interface NormalizedEvent {
  id: string;
  name: string;
  startsAt: string;
  channelId: string | null;
  description: string | null;
  status: EventStatus;
}

const STATUS_BY_NUMBER = new Map<number, EventStatus>([
  [1, 'scheduled'],
  [2, 'active'],
  [3, 'completed'],
  [4, 'cancelled'],
]);

const STATUSES: ReadonlySet<string> = new Set(['scheduled', 'active', 'completed', 'cancelled']);

export interface InvalidEvent {
  index: number;
  reason: string;
}

/** Normalize one raw object from either side; null when it cannot be compared. */
export function normalizeEvent(raw: unknown): { event?: NormalizedEvent; error?: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  const id = r['id'] ?? r['event_id'];
  if (typeof id !== 'string' || id.length === 0) return { error: 'missing id/event_id' };
  if (typeof r['name'] !== 'string' || r['name'].length === 0) return { error: `event ${id}: missing name` };
  const startsRaw = r['scheduled_start_time'] ?? r['starts_at'];
  if (typeof startsRaw !== 'string' || !Number.isFinite(Date.parse(startsRaw))) {
    return { error: `event ${id}: bad scheduled_start_time/starts_at` };
  }
  const statusRaw = r['status'];
  const status =
    typeof statusRaw === 'number'
      ? STATUS_BY_NUMBER.get(statusRaw)
      : typeof statusRaw === 'string' && STATUSES.has(statusRaw)
        ? (statusRaw as EventStatus)
        : undefined;
  if (!status) return { error: `event ${id}: bad status ${JSON.stringify(statusRaw)}` };
  return {
    event: {
      id,
      name: r['name'],
      startsAt: new Date(startsRaw).toISOString(),
      channelId: typeof r['channel_id'] === 'string' ? r['channel_id'] : null,
      description: typeof r['description'] === 'string' ? r['description'] : null,
      status,
    },
  };
}

export interface FieldDrift {
  id: string;
  changes: string[];
}

export interface DriftReport {
  agentCount: number;
  liveCount: number;
  onlyInAgent: string[];
  onlyInLive: string[];
  fieldDrift: FieldDrift[];
  invalid: InvalidEvent[];
}

const COMPARE_FIELDS = ['name', 'startsAt', 'channelId', 'description', 'status'] as const;

function fmt(value: unknown): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/** Parse + normalize one snapshot file body; invalid rows are reported, not thrown. */
export function loadSnapshot(body: unknown): { events: Map<string, NormalizedEvent>; invalid: InvalidEvent[] } {
  const list = Array.isArray(body) ? body : (body as { events?: unknown })?.events;
  if (!Array.isArray(list)) throw new Error('snapshot must be a JSON array or {"events": [...]}');
  const events = new Map<string, NormalizedEvent>();
  const invalid: InvalidEvent[] = [];
  list.forEach((raw, index) => {
    const { event, error } = normalizeEvent(raw);
    if (!event || error) {
      invalid.push({ index, reason: error ?? 'unknown' });
      return;
    }
    // Last write wins on duplicate ids; the duplicate itself is not drift.
    events.set(event.id, event);
  });
  return { events, invalid };
}

export function compareSnapshots(
  agent: Map<string, NormalizedEvent>,
  live: Map<string, NormalizedEvent>,
): Omit<DriftReport, 'agentCount' | 'liveCount' | 'invalid'> {
  const onlyInAgent = [...agent.keys()].filter((id) => !live.has(id)).sort();
  const onlyInLive = [...live.keys()].filter((id) => !agent.has(id)).sort();
  const fieldDrift: FieldDrift[] = [];
  for (const [id, a] of [...agent.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const b = live.get(id);
    if (!b) continue;
    const changes: string[] = [];
    for (const field of COMPARE_FIELDS) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        changes.push(`${field}: ${fmt(a[field])} -> ${fmt(b[field])}`);
      }
    }
    if (changes.length > 0) fieldDrift.push({ id, changes });
  }
  return { onlyInAgent, onlyInLive, fieldDrift };
}

export function hasDrift(report: Pick<DriftReport, 'onlyInAgent' | 'onlyInLive' | 'fieldDrift'>): boolean {
  return report.onlyInAgent.length > 0 || report.onlyInLive.length > 0 || report.fieldDrift.length > 0;
}

/** Human-readable diff lines; the verdict line is last. */
export function formatReport(agentPath: string, livePath: string, report: DriftReport): string[] {
  const lines = [
    `${agentPath} (${report.agentCount} event(s)) vs ${livePath} (${report.liveCount} event(s))`,
    `only in agent: ${report.onlyInAgent.join(', ') || 'none'}`,
    `only in live: ${report.onlyInLive.join(', ') || 'none'}`,
  ];
  for (const { id, changes } of report.fieldDrift) {
    lines.push(`event field drift: ${id}: ${changes.join('; ')}`);
  }
  for (const { index, reason } of report.invalid) {
    lines.push(`invalid row ${index}: ${reason}`);
  }
  lines.push(
    hasDrift(report)
      ? 'DRIFT: the live guild no longer matches what the agent recorded. Every line above is either a real guild change or a poller bug worth investigating.'
      : 'IN-SYNC: the live guild matches what the agent recorded.',
  );
  return lines;
}

function usage(): string[] {
  return [
    'usage: node scripts/scheduled-events-drift.ts <agent.json> <live.json>',
    '',
    'Compare the agent-recorded scheduled events against a live-guild capture field by field.',
    'Exit 0 means in sync; exit 1 names the drift; exit 2 is a usage or input error.',
    'Read-only, no token, no network, no database; --help and --selftest read nothing.',
  ];
}

// --- self-test: mock data with and without drift, no token or database needed ---
const MOCK_AGENT = [
  {
    id: 'event-1',
    name: 'Sunday Squad',
    scheduled_start_time: '2026-09-06T18:30:00+01:00',
    channel_id: 'voice-1',
    description: 'Join the weekly games night.',
    status: 1,
  },
  { id: 'event-2', name: 'Morning Raid', scheduled_start_time: '2026-09-07T18:00:00.000Z', status: 1 },
];

const MOCK_LIVE_CLEAN = [
  {
    event_id: 'event-1',
    name: 'Sunday Squad',
    starts_at: '2026-09-06T17:30:00.000Z',
    channel_id: 'voice-1',
    description: 'Join the weekly games night.',
    status: 'scheduled',
  },
  { event_id: 'event-2', name: 'Morning Raid', starts_at: '2026-09-07T18:00:00.000Z', channel_id: null, description: null, status: 'scheduled' },
];

const MOCK_LIVE_DRIFT = [
  {
    id: 'event-1',
    name: 'Sunday Squad Renamed',
    scheduled_start_time: '2026-09-06T17:30:00.000Z',
    channel_id: 'voice-1',
    description: 'Join the weekly games night.',
    status: 2,
  },
  { id: 'event-3', name: 'Surprise Party', scheduled_start_time: '2026-09-08T18:00:00.000Z', status: 1 },
];

export function runSelftest(): { passed: boolean; lines: string[] } {
  const lines: string[] = [];
  let failed = 0;
  const check = (name: string, cond: boolean, detail = '') => {
    if (!cond) failed++;
    lines.push(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
  };

  // Case 1: same events in different shapes (raw Discord vs DB row) must be in sync.
  const agent = loadSnapshot(MOCK_AGENT);
  const clean = loadSnapshot(MOCK_LIVE_CLEAN);
  check('inputs normalize without invalid rows', agent.invalid.length === 0 && clean.invalid.length === 0);
  const cleanReport: DriftReport = {
    agentCount: agent.events.size,
    liveCount: clean.events.size,
    invalid: [],
    ...compareSnapshots(agent.events, clean.events),
  };
  check('identical events in different shapes exit 0', !hasDrift(cleanReport));

  // Case 2: renamed + status change + removed + added must all be named.
  const drift = loadSnapshot(MOCK_LIVE_DRIFT);
  const driftReport: DriftReport = {
    agentCount: agent.events.size,
    liveCount: drift.events.size,
    invalid: [],
    ...compareSnapshots(agent.events, drift.events),
  };
  check('drifted pair exits nonzero', hasDrift(driftReport));
  check('removed event named', driftReport.onlyInAgent.join() === 'event-2', `onlyInAgent=${driftReport.onlyInAgent.join()}`);
  check('added event named', driftReport.onlyInLive.join() === 'event-3', `onlyInLive=${driftReport.onlyInLive.join()}`);
  const renamed = driftReport.fieldDrift.find((d) => d.id === 'event-1');
  check(
    'renamed event names name + status changes',
    renamed !== undefined &&
      renamed.changes.some((c) => c.startsWith('name:')) &&
      renamed.changes.some((c) => c.startsWith('status: "scheduled" -> "active"')),
    renamed?.changes.join('; ') ?? 'missing',
  );

  // Case 3: malformed rows are input errors, not drift.
  const bad = loadSnapshot([{ id: 'x', name: 'No start', status: 1 }]);
  check('malformed row reported as invalid', bad.invalid.length === 1 && bad.events.size === 0);

  lines.push(failed === 0 ? '\nself-test passed\n' : `\nself-test FAILED (${failed})\n`);
  return { passed: failed === 0, lines };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  // --help prints usage with no snapshot reads and no network.
  if (process.argv.includes('--help')) {
    for (const line of usage()) console.log(line);
    process.exit(0);
  }
  if (process.argv.includes('--selftest')) {
    const { passed, lines } = runSelftest();
    console.log('scheduled-events drift self-test (mock data, no token, no database)\n');
    for (const line of lines) console.log(line);
    console.log('without drift: exit 0 (IN-SYNC); with drift: exit 1 (DRIFT) — see cases above.');
    process.exit(passed ? 0 : 1);
  }

  const [agentPath, livePath] = process.argv.slice(2);
  if (!agentPath || !livePath) {
    console.error('usage: node scripts/scheduled-events-drift.ts <agent.json> <live.json>');
    process.exit(2);
  }
  let agentBody: unknown;
  let liveBody: unknown;
  try {
    agentBody = JSON.parse(readFileSync(agentPath, 'utf8')) as unknown;
    liveBody = JSON.parse(readFileSync(livePath, 'utf8')) as unknown;
  } catch (err) {
    console.error(`cannot read snapshot: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  let agent: { events: Map<string, NormalizedEvent>; invalid: InvalidEvent[] };
  let live: { events: Map<string, NormalizedEvent>; invalid: InvalidEvent[] };
  try {
    agent = loadSnapshot(agentBody);
    live = loadSnapshot(liveBody);
  } catch (err) {
    console.error(`invalid snapshot: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const report: DriftReport = {
    agentCount: agent.events.size,
    liveCount: live.events.size,
    invalid: [...agent.invalid.map((i) => ({ ...i, reason: `${agentPath}: ${i.reason}` })), ...live.invalid.map((i) => ({ ...i, reason: `${livePath}: ${i.reason}` }))],
    ...compareSnapshots(agent.events, live.events),
  };
  for (const line of formatReport(agentPath, livePath, report)) console.log(line);
  if (report.invalid.length > 0) process.exit(2);
  process.exit(hasDrift(report) ? 1 : 0);
}

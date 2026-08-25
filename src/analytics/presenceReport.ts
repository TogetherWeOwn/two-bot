/**
 * Render the presence series for a human (TOG-469).
 *
 * A pure string builder, so the thing a person reads is covered by tests
 * rather than eyeballed once. `scripts/presence-trend.ts` is a thin wrapper
 * that opens a database and prints what this returns.
 *
 * This is a TERMINAL report and the only place a human estimate is allowed to
 * appear. It is computed here, at print time, next to its caveat - never
 * stored, because a column called `human_estimate` outlives the caveat and
 * gets published by whoever finds it next. See migration 0004.
 */
import {
  dailyPeaks,
  latestBotFloor,
  type PresenceReading,
  type TriggerVerdict,
} from './presence.ts';

/** Bar width for the busiest day, in characters. */
const BAR_WIDTH = 28;

function bar(value: number, max: number): string {
  if (max <= 0) return '';
  const n = Math.max(1, Math.round((value / max) * BAR_WIDTH));
  return '#'.repeat(n);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

export interface ReportOptions {
  guildId: string;
  verdict: TriggerVerdict;
  /** Limit the table to the most recent N days. All of them if omitted. */
  days?: number;
}

export function renderPresenceReport(readings: PresenceReading[], opts: ReportOptions): string {
  const out: string[] = [];
  const { verdict } = opts;

  out.push('presence probe (TOG-469) - INTERNAL ONLY, never published');
  out.push(`guild ${opts.guildId}`);
  out.push('');

  if (readings.length === 0) {
    out.push('No readings yet.');
    out.push('');
    out.push('The collector runs hourly inside the bot and needs Postgres and');
    out.push('DISCORD_GUILD_ID. Check for `presence_probe_enabled` in the bot log;');
    out.push('`presence_probe_disabled` says which of the two is missing.');
    return out.join('\n');
  }

  let days = dailyPeaks(readings, verdict.threshold);
  const totalDays = days.length;
  if (opts.days && days.length > opts.days) days = days.slice(-opts.days);

  const max = Math.max(...days.map((d) => d.peak));

  out.push(`  ${pad('day', 12)}${padLeft('n', 4)}${padLeft('low', 6)}${padLeft('peak', 6)}  chart`);
  for (const d of days) {
    // The marker is the trigger's own answer for that day, not a second
    // opinion: both come from dailyPeaks() with the same threshold.
    const mark = d.qualifies ? ' <- >= ' + verdict.threshold : '';
    out.push(
      `  ${pad(d.date, 12)}${padLeft(String(d.readings), 4)}${padLeft(String(d.low), 6)}` +
        `${padLeft(String(d.peak), 6)}  ${bar(d.peak, max)}${mark}`,
    );
  }
  out.push('');

  const floor = latestBotFloor(readings);
  out.push(`readings        ${readings.length} over ${totalDays} day(s)`);
  out.push(`window          trailing ${verdict.windowDays} days`);
  out.push(
    `peak in window  ${verdict.peak ?? 'none'}${verdict.peakAt ? `  at ${verdict.peakAt}` : ''}`,
  );
  out.push(`bot floor       ${floor === null ? 'never observed' : floor}`);

  if (floor !== null && verdict.peak !== null) {
    // The one derivation, with the reason it is not a fact attached to it.
    // `approximate_presence_count` is Discord's own approximation and the floor
    // counts bot ACCOUNTS rather than bots currently online, so this subtraction
    // has no defined error bar. It is a rough sense of scale and nothing more.
    out.push(
      `humans (rough)  ~${verdict.peak - floor} at peak - a subtraction of two ` +
        `approximations, not a measurement. Never publish this number.`,
    );
  }
  out.push('');

  out.push(`trigger         ${verdict.status.toUpperCase()}`);
  out.push(
    `                ${verdict.qualifyingDays}/${verdict.requiredDays} qualifying days ` +
      `(peak >= ${verdict.threshold}), web_v1 live: ${verdict.webV1Live ? 'yes' : 'not asserted'}`,
  );
  for (const line of wrap(verdict.reason, 62)) out.push(`                ${line}`);

  return out.join('\n');
}

/** Naive word wrap. Report text only. */
export function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

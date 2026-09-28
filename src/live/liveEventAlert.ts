/**
 * Staging-only live-event alert (TOG-7185).
 *
 * Detection: a scheduled event going live (status -> active). In staging the
 * alert is written to a log/evidence file (JSONL, one line per alert) and
 * NEVER posted to a channel. The channel-post path exists only as an injected
 * dependency so tests can prove it never executes — this module has no import
 * that can reach Discord.
 *
 * Staging-only: the staging guild id is the whole allowlist. Any other guild
 * throws before the sink or the poster is touched. `announcements` is the
 * live-cleared capability for real posts; this module is not that path and
 * must never become it.
 */

import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { TWO_STAGING_GUILD_ID } from '../staging/spec.ts';

export interface LiveEventDetection {
  guildId: string;
  eventId: string;
  eventName: string;
  scheduledStartTime?: string | null;
  voiceChannelId?: string | null;
}

export interface LiveEventAlertRecord {
  kind: 'live_event_alert';
  environment: 'staging';
  guildId: string;
  eventId: string;
  eventName: string;
  scheduledStartTime: string | null;
  voiceChannelId: string | null;
  detectedAt: string;
}

export type LiveEventAlertSink = (record: LiveEventAlertRecord) => void;

/**
 * The public-post code path. Injected so staging runs and tests can prove it
 * never executes; this module never calls it.
 */
export type LiveEventChannelPoster = (channelId: string, content: string) => Promise<unknown>;

export interface HandleLiveEventAlertDeps {
  sink: LiveEventAlertSink;
  /** Present only to name the forbidden path. Never called. */
  poster?: LiveEventChannelPoster;
  channelId?: string;
  /** Event ids already alerted; a repeat detection logs nothing. */
  seenEventIds?: Set<string>;
  now?: () => string;
}

export interface HandleLiveEventAlertResult {
  logged: boolean;
  posted: false;
  duplicate: boolean;
}

/**
 * Append-and-fsync sink. The fsync is the difference between "we have a
 * record of what we did" and "we have a record of what we did unless the box
 * lost power", and at one call per live event it costs nothing worth saving.
 */
export function fileLiveEventAlertSink(path: string): LiveEventAlertSink {
  return (record) => {
    const fd = openSync(path, 'a');
    try {
      appendFileSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
}

export function assertStagingLiveEventGuild(guildId: string): void {
  if (guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(
      `Live-event alerts are staging-only: expected guild ${TWO_STAGING_GUILD_ID}, ` +
        `got ${guildId || 'unset'}. Refusing to log or post.`,
    );
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a Discord id.`);
}

export async function handleLiveEventAlert(
  detection: LiveEventDetection,
  deps: HandleLiveEventAlertDeps,
): Promise<HandleLiveEventAlertResult> {
  assertStagingLiveEventGuild(detection.guildId);
  assertSnowflake(detection.eventId, 'event id');
  const eventName = detection.eventName.trim();
  if (!eventName) throw new Error('event name must not be blank.');
  if (deps.seenEventIds?.has(detection.eventId)) {
    return { logged: false, posted: false, duplicate: true };
  }
  const detectedAt = (deps.now ?? (() => new Date().toISOString()))();
  deps.sink({
    kind: 'live_event_alert',
    environment: 'staging',
    guildId: detection.guildId,
    eventId: detection.eventId,
    eventName,
    scheduledStartTime: detection.scheduledStartTime ?? null,
    voiceChannelId: detection.voiceChannelId ?? null,
    detectedAt,
  });
  deps.seenEventIds?.add(detection.eventId);
  // No post: staging learns from the log, never from a public channel.
  return { logged: true, posted: false, duplicate: false };
}

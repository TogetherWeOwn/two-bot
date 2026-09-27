/**
 * Channel-name filtering for temp voice (TOG-3052).
 *
 * This deliberately runs the EXISTING automod matcher rather than a second,
 * parallel word list. A name is fed to `matchAutomod` as a synthetic message so
 * that a word blocked in chat is blocked in a channel name by construction -
 * two lists would drift, and the one nobody looks at would be the loose one.
 *
 * Only the content-shaped filters apply: a name cannot mention anybody, carry
 * an attachment, or be a repeat of itself.
 */
import { matchAutomod, type RepeatTracker } from '../automod/matcher.ts';
import type { AutomodFilter, AutomodMessage, AutomodPolicy } from '../automod/types.ts';

/** Discord's own bounds for a channel name. */
export const MIN_CHANNEL_NAME_LENGTH = 1;
export const MAX_CHANNEL_NAME_LENGTH = 100;

const NAME_FILTERS: ReadonlySet<AutomodFilter> = new Set<AutomodFilter>([
  'bad_words',
  'invite_link',
  'external_link',
]);

/** A name is never a repeat of an earlier name, so this never fires. */
const NO_REPEATS: RepeatTracker = { observe: () => false };

export type NameRejection =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/**
 * Control characters and Discord's markdown/mention sigils are stripped rather
 * than rejected: a user typing `@everyone` into a channel name wants a name,
 * not an error, and the name is never rendered as message content anyway.
 */
function sanitize(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/[@`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function filterChannelName(
  raw: string,
  policy: AutomodPolicy,
  context: { guildId: string; channelId: string; userId: string },
): NameRejection {
  const name = sanitize(raw);
  if (name.length < MIN_CHANNEL_NAME_LENGTH) {
    return { ok: false, reason: 'That name is empty once formatting is removed.' };
  }
  if (name.length > MAX_CHANNEL_NAME_LENGTH) {
    return { ok: false, reason: `Channel names are at most ${MAX_CHANNEL_NAME_LENGTH} characters.` };
  }

  const message: AutomodMessage = {
    guildId: context.guildId,
    channelId: context.channelId,
    messageId: `temp-voice-name:${context.channelId}`,
    authorId: context.userId,
    authorIsBot: false,
    roleIds: [],
    content: name,
    mentionedUserIds: [],
    attachmentNames: [],
    observedTimestamp: 0,
  };
  // `matchAutomod` returns the FIRST filter that fires, so the inapplicable
  // ones are neutralised rather than ignored afterwards: a guild running
  // mentionLimit 0 would otherwise short-circuit on `mention_spam` and never
  // reach the invite-link check, quietly letting `discord.gg/x` become a
  // channel name.
  const nameScopedPolicy: AutomodPolicy = {
    ...policy,
    mentionLimit: Number.POSITIVE_INFINITY,
    repeatedMessageCount: Number.POSITIVE_INFINITY,
    blockedAttachmentExtensions: [],
  };
  const filter = matchAutomod(message, nameScopedPolicy, NO_REPEATS);
  if (filter && NAME_FILTERS.has(filter)) {
    return { ok: false, reason: `That name is not allowed here (${filter.replace(/_/gu, ' ')}).` };
  }
  return { ok: true, name };
}

/**
 * Render the configured template. `{count}` is the owner's live channel count
 * and `{seq}` the guild-wide one, both 1-based at the moment of creation.
 */
export function renderNameTemplate(
  template: string,
  values: { username: string; count: number; seq: number },
): string {
  const rendered = template
    .replaceAll('{username}', values.username)
    .replaceAll('{count}', String(values.count))
    .replaceAll('{seq}', String(values.seq));
  const trimmed = sanitize(rendered);
  return (trimmed || 'voice channel').slice(0, MAX_CHANNEL_NAME_LENGTH);
}

/**
 * Gateway wiring for the member-facing halves of the automations feature
 * (TOG-1648): text-trigger commands and sticky re-posts.
 *
 * Both hang off events the funnel already consumes, and both are deliberately
 * metadata-only. The privacy stance in docs/PRIVACY.md - "we count that a
 * message happened; we never read what it said" - is why:
 *
 *   * Sticky re-post needs only the channel id and the timestamp. Whether the
 *     member said "hi" or pasted a paragraph, the sticky's job is the same.
 *   * Text triggers DO need the first word of the message. That requires the
 *     privileged MessageContent intent, so the whole feature is opt-in via
 *     TWO_TEXT_COMMANDS=1 (see client.ts), and even then the bot reads only
 *     the first whitespace-delimited token, in memory, of messages that start
 *     with '!'. Nothing is stored.
 */
import type { Client } from 'discord.js';
import type { AutomationService } from './service.ts';
import { renderTemplate } from './template.ts';
import type { AutomationCommandRow } from './store.ts';
import { log } from '../core/log.ts';
import { BUILTIN_COMMAND_NAMES } from '../discord/commandNames.ts';

export interface GatewayOptions {
  guildId: string;
  service: AutomationService;
  /** Content processing stays off unless the privileged feature is explicitly enabled. */
  textCommandsEnabled: boolean;
  /** Look up the command a trigger word maps to. */
  findTrigger: (guildId: string, word: string) => Promise<AutomationCommandRow | null>;
}

/** Everything after the leading '!' up to the first whitespace. */
export function triggerWord(content: string): string | null {
  if (!content.startsWith('!')) return null;
  const word = content.slice(1).split(/\s/, 1)[0];
  return word ? `!${word.toLowerCase()}` : null;
}

export function registerAutomationGateway(client: Client, opts: GatewayOptions): void {
  client.on('automationMessageAccepted' as never, async (msg: { guildId?: string | null; author?: { bot?: boolean; id?: string }; channelId?: string | null; content?: string; createdTimestamp?: number }) => {
    const guildId = msg.guildId;
    if (!guildId || guildId !== opts.guildId || !msg.channelId) return;
    if (msg.author?.bot) return; // our own sticky re-posts must not re-trigger anything

    // The sticky check is metadata-only and runs only after the primary gateway
    // handler has accepted the message through automod.
    try {
      const stickyOutcome = await opts.service.onChannelActivity(
        guildId,
        msg.channelId,
        msg.author?.id ?? '',
      );
      if (stickyOutcome === 'reposted') log.info('sticky_reposted', { guildId, channelId: msg.channelId });
    } catch (err) {
      log.error('sticky_check_failed', { guildId, channelId: msg.channelId, err: String(err) });
    }

    // Discord exposes some exempt content (such as app mentions) even without
    // MessageContent. The feature flag therefore gates processing, not just the
    // gateway intent, so slash-only mode cannot accidentally answer `!` text.
    if (!opts.textCommandsEnabled) return;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content.startsWith('!')) return;
    const word = triggerWord(content);
    if (!word || BUILTIN_COMMAND_NAMES.has(word.slice(1))) return;
    try {
      const command = await opts.findTrigger(guildId, word);
      if (!command) return;
      // Render inside runCommand as well as posting through it, so a rendered
      // output that breaches Discord's ceiling leaves the same durable failed
      // audit row as a delivery failure.
      await opts.service.postTextReply(
        guildId,
        msg.channelId,
        command.name,
        msg.author?.id ?? '',
        () => renderTemplate(command.template, {
          user: `<@${msg.author?.id}>`,
          username: String(msg.author?.id),
          server: '',
          channel: `<#${msg.channelId}>`,
        }),
      );
      log.info('text_command_fired', { guildId, command: command.name, trigger: word });
    } catch (err) {
      log.error('text_command_failed', { guildId, trigger: word, err: String(err) });
    }
  });
}

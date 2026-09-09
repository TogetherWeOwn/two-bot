export const AUTOMOD_FILTERS = [
  'bad_words',
  'repeated_message',
  'mention_spam',
  'invite_link',
  'external_link',
  'attachment_type',
] as const;

export type AutomodFilter = (typeof AUTOMOD_FILTERS)[number];

export interface AutomodSanction {
  violations: number;
  action: 'delete' | 'warn' | 'timeout';
  timeoutSeconds?: number;
}

export interface AutomodPolicy {
  badWords: string[];
  blockedAttachmentExtensions: string[];
  allowedDomains: string[];
  repeatedMessageCount: number;
  repeatedMessageWindowSeconds: number;
  mentionLimit: number;
  bypassRoleIds: ReadonlySet<string>;
  exemptChannelIds: ReadonlySet<string>;
  sanctions: AutomodSanction[];
}

export interface AutomodMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  roleIds: string[];
  content: string;
  mentionedUserIds: string[];
  attachmentNames: string[];
  observedTimestamp: number;
}

export interface AutomodResult {
  matched: boolean;
  deleted: boolean;
  filter?: AutomodFilter;
  sanction?: AutomodSanction['action'];
  replayed?: boolean;
}

export class AutomodProcessingError extends Error {
  matched: boolean;

  constructor(cause: unknown, matched: boolean) {
    super(String(cause));
    this.name = 'AutomodProcessingError';
    this.cause = cause;
    this.matched = matched;
  }
}

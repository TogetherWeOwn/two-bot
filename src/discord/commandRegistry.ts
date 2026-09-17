import { Events, type ApplicationCommandDataResolvable, type Client } from 'discord.js';
import type { AutomationStore } from '../automations/store.ts';
import { log } from '../core/log.ts';
import {
  BUILTIN_COMMAND_NAMES,
  CORE_COMMAND_DATA,
  DISCORD_GUILD_COMMAND_LIMIT,
  commandName,
} from './commandNames.ts';

function builtinCommands(
  additional: readonly ApplicationCommandDataResolvable[] = [],
): ApplicationCommandDataResolvable[] {
  return [...CORE_COMMAND_DATA, ...additional];
}

export function mergedCommandData(
  custom: readonly { name: string; description: string; enabled: boolean }[],
  additionalBuiltins: readonly ApplicationCommandDataResolvable[] = [],
): ApplicationCommandDataResolvable[] {
  const builtins = builtinCommands(additionalBuiltins);
  const reservedNames = new Set([
    ...BUILTIN_COMMAND_NAMES,
    ...builtins.map(commandName),
  ]);
  const customNames = new Set<string>();
  if (builtins.length > DISCORD_GUILD_COMMAND_LIMIT) {
    throw new Error(
      `Owen defines ${builtins.length} built-in commands, above Discord's guild limit of ${DISCORD_GUILD_COMMAND_LIMIT}.`,
    );
  }
  const customCommands = custom
    .filter((command) => command.enabled && !reservedNames.has(command.name))
    .filter((command) => {
      if (customNames.has(command.name)) return false;
      customNames.add(command.name);
      return true;
    })
    .map((command) => ({ name: command.name, description: command.description }));
  const commands = [...builtins, ...customCommands];
  if (commands.length > DISCORD_GUILD_COMMAND_LIMIT) {
    throw new Error(
      `Command registry contains ${commands.length} commands, above Discord's guild limit of ${DISCORD_GUILD_COMMAND_LIMIT}.`,
    );
  }
  return commands;
}

export interface CommandRegistryOptions {
  guildId: string;
  automations: AutomationStore;
  /** Every other enabled feature's commands. This registry is the only writer. */
  additionalBuiltins?: readonly ApplicationCommandDataResolvable[];
  /**
   * Whether DB-backed custom commands may be published at all. Default true.
   * With automations disabled this registry must not put them back: the
   * disable sweep in src/automations/disable.ts deletes them, and the very
   * next sync would otherwise re-publish every one (TOG-3189).
   */
  automationsEnabled?: boolean;
  /**
   * Awaited once on ready, before the first sync replaces the guild's command
   * set. The automations disable sweep (src/automations/disable.ts) hangs here
   * rather than off its own ready listener: it has to read the set Discord is
   * actually publishing, and two independent ready handlers would race.
   * A failure here is logged and the sync still runs.
   */
  beforeFirstSync?: () => Promise<void>;
}

/**
 * The one owner of the guild application-command set. Discord's `set` endpoint
 * replaces the complete set, so feature slices must merge here rather than each
 * registering their own partial view and deleting everybody else's commands.
 */
export class CommandRegistry {
  private client: Client;
  private guildId: string;
  private automations: AutomationStore;
  private additionalBuiltins: readonly ApplicationCommandDataResolvable[];
  private automationsEnabled: boolean;
  private beforeFirstSync?: () => Promise<void>;
  private syncTail: Promise<void> = Promise.resolve();

  constructor(client: Client, options: CommandRegistryOptions) {
    this.client = client;
    this.guildId = options.guildId;
    this.automations = options.automations;
    this.additionalBuiltins = options.additionalBuiltins ?? [];
    this.automationsEnabled = options.automationsEnabled ?? true;
    this.beforeFirstSync = options.beforeFirstSync;
  }

  register(): void {
    this.client.once(Events.ClientReady, async () => {
      if (this.beforeFirstSync) {
        try {
          await this.beforeFirstSync();
        } catch (err) {
          // Never let a pre-sync step cost the guild its command registry.
          log.error('guild_command_pre_sync_failed', { guildId: this.guildId, err: String(err) });
        }
      }
      try {
        const count = await this.sync();
        log.info('guild_commands_ready', { guildId: this.guildId, count });
      } catch (err) {
        log.error('guild_command_sync_failed', { guildId: this.guildId, err: String(err) });
      }
    });
  }

  async sync(): Promise<number> {
    const previous = this.syncTail;
    let release!: () => void;
    this.syncTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      const guild = this.client.guilds.cache.get(this.guildId);
      if (!guild) throw new Error(`Guild ${this.guildId} is not cached.`);

      // Read after every earlier sync has published. Discord's `set` replaces the
      // complete registry, so letting two snapshots overlap can publish them in
      // reverse order and resurrect an older definition set.
      const commands = mergedCommandData(
        this.automationsEnabled ? await this.automations.listCommands(this.guildId) : [],
        this.additionalBuiltins,
      );
      await guild.commands.set(commands);
      return commands.length;
    } finally {
      release();
    }
  }
}

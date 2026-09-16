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
  private syncTail: Promise<void> = Promise.resolve();

  constructor(client: Client, options: CommandRegistryOptions) {
    this.client = client;
    this.guildId = options.guildId;
    this.automations = options.automations;
    this.additionalBuiltins = options.additionalBuiltins ?? [];
  }

  register(): void {
    this.client.once(Events.ClientReady, async () => {
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
        await this.automations.listCommands(this.guildId),
        this.additionalBuiltins,
      );
      await guild.commands.set(commands);
      return commands.length;
    } finally {
      release();
    }
  }
}

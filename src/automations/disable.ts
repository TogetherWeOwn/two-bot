/**
 * Disable-time removal of DB-backed custom slash commands (TOG-3189).
 *
 * `loadAutomationConfig` flipping to `{enabled: false}` used to leave every
 * admin-defined command published with Discord and answering: the config flag
 * gated *wiring*, never the command set that was already registered. Disabled
 * that leaves live commands answering is not disabled.
 *
 * Two independent halves, both required:
 *
 *   * this module deregisters the commands, so they stop appearing in pickers;
 *   * `registerAutomationCommands({enabled: false})` refuses invocations, so an
 *     interaction already in flight when the delete lands still gets a "no"
 *     rather than an execution.
 *
 * The delete set is scoped from the DATABASE, never from "everything Discord
 * currently lists". Owen's own built-ins, and anything another application
 * registered, live in the same guild command list; a disable that read that
 * list as its work queue would be a wipe, not a scoped removal.
 */
import type { AutomationCommandRow } from './store.ts';

/** Just the part of AutomationStore this needs; keeps the unit test db-free. */
export interface CommandNameSource {
  listCommands(guildId: string): Promise<AutomationCommandRow[]>;
}

export interface RegisteredGuildCommand {
  id: string;
  name: string;
}

/** The Discord application-command surface, injectable for tests and the mock. */
export interface GuildCommandRegistrar {
  listGuildCommands(): Promise<RegisteredGuildCommand[]>;
  deleteGuildCommand(commandId: string): Promise<void>;
}

export interface AutomationDisableResult {
  guildId: string;
  /** Command names read out of the database - the complete, only delete set. */
  dbBacked: string[];
  /** Names that were registered and are now deleted. One API call each. */
  removed: string[];
  /** DB-backed names Discord was not publishing. No call issued; not an error. */
  alreadyAbsent: string[];
  /** Names still published because their delete failed. */
  failed: { name: string; commandId: string; error: string }[];
  /** Registered names left alone because no row in the database claims them. */
  untouched: string[];
}

/**
 * A partial removal. Thrown rather than returned so a caller cannot mistake a
 * half-removed command set for a clean disable by ignoring a return value; the
 * full per-command breakdown rides along on `.result`.
 */
export class AutomationDisableIncomplete extends Error {
  readonly result: AutomationDisableResult;

  constructor(result: AutomationDisableResult) {
    super(
      `Automations disable removed ${result.removed.length} of ` +
        `${result.removed.length + result.failed.length} registered custom command(s); ` +
        `still published: ${result.failed.map((f) => f.name).join(', ')}`,
    );
    this.name = 'AutomationDisableIncomplete';
    this.result = result;
  }
}

/** Human-readable one-liner for logs and the operator proof script. */
export function summariseDisable(result: AutomationDisableResult): string {
  return (
    `guild=${result.guildId} db=${result.dbBacked.length} removed=${result.removed.length} ` +
    `already-absent=${result.alreadyAbsent.length} failed=${result.failed.length} ` +
    `untouched=${result.untouched.length}`
  );
}

/**
 * Deregister every DB-backed custom command this guild has published.
 *
 * Idempotent: the database rows are deliberately left alone (disable is not a
 * destructive admin action), so a second run finds the same names, sees none of
 * them registered, issues zero calls, and returns them as `alreadyAbsent`.
 *
 * A failing delete does not abort the sweep - the remaining commands are still
 * worth removing - but it does make the whole call throw at the end.
 *
 * @throws AutomationDisableIncomplete if any delete failed.
 */
export async function removeDbBackedCommands(
  guildId: string,
  store: CommandNameSource,
  registrar: GuildCommandRegistrar,
): Promise<AutomationDisableResult> {
  const rows = await store.listCommands(guildId);
  // Disabled rows were never published, but a row that was disabled *after*
  // publication still has a live command, so the delete set is every row.
  const dbBacked = [...new Set(rows.map((row) => row.name))].sort();
  const dbBackedSet = new Set(dbBacked);

  const registered = await registrar.listGuildCommands();
  const byName = new Map<string, string>();
  const untouched: string[] = [];
  for (const command of registered) {
    if (dbBackedSet.has(command.name)) byName.set(command.name, command.id);
    else untouched.push(command.name);
  }

  const result: AutomationDisableResult = {
    guildId,
    dbBacked,
    removed: [],
    alreadyAbsent: [],
    failed: [],
    untouched: untouched.sort(),
  };

  for (const name of dbBacked) {
    const commandId = byName.get(name);
    if (commandId === undefined) {
      result.alreadyAbsent.push(name);
      continue;
    }
    try {
      await registrar.deleteGuildCommand(commandId);
      result.removed.push(name);
    } catch (err) {
      result.failed.push({ name, commandId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (result.failed.length > 0) throw new AutomationDisableIncomplete(result);
  return result;
}

const API = 'https://discord.com/api/v10';

export interface RestGuildCommandRegistrarOptions {
  token: string;
  applicationId: string;
  guildId: string;
  /** Override the API host. Used by tests and tools/mock-discord. */
  base?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The real guild application-command surface. Deliberately a plain REST client
 * rather than discord.js' `guild.commands`: `guild.commands.set()` is a bulk
 * overwrite of the whole registry, and the one thing this must never do is
 * decide the fate of a command it did not read out of the database.
 */
export class RestGuildCommandRegistrar implements GuildCommandRegistrar {
  private token: string;
  private base: string;
  private path: string;
  private fetchImpl: typeof fetch;

  constructor(o: RestGuildCommandRegistrarOptions) {
    this.token = o.token;
    this.base = o.base ?? API;
    this.path = `/applications/${o.applicationId}/guilds/${o.guildId}/commands`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async listGuildCommands(): Promise<RegisteredGuildCommand[]> {
    const res = await this.fetchImpl(`${this.base}${this.path}`, {
      method: 'GET',
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!res.ok) throw new Error(`Discord refused the command list: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('Discord returned a non-array command list.');
    return body
      .map((entry) => entry as { id?: unknown; name?: unknown })
      .filter((entry) => typeof entry.id === 'string' && typeof entry.name === 'string')
      .map((entry) => ({ id: entry.id as string, name: entry.name as string }));
  }

  async deleteGuildCommand(commandId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}${this.path}/${commandId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${this.token}` },
    });
    // 404: somebody else already removed it. Un-deleting is impossible, so an
    // absent command is the state this was asking for.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Discord refused the command delete: HTTP ${res.status}`);
    }
  }
}

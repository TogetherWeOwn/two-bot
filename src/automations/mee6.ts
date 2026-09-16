/**
 * MEE6 custom-command export/import translation (TOG-1648).
 *
 * MEE6's dashboard exports custom commands as a JSON array of objects shaped
 * roughly like:
 *
 *   { "command": "faq", "description": "...", "response": "..." }
 *
 * (field spellings vary a little by MEE6 version; the reader accepts the
 * three known spellings and nothing else). Translation rules:
 *
 *   * command name: lowercased, invalid characters dropped, truncated to 32.
 *     That cleaned name is the stable import key, so a changed export updates
 *     the same Owen row instead of minting a suffix.
 *   * response -> template. MEE6's own placeholders are a superset of ours;
 *     the unsupported ones are mapped when there is an exact equivalent and
 *     stripped of their braces otherwise, so text renders rather than leaks
 *     syntax at members.
 *   * text trigger: MEE6 commands ARE text commands (`!faq`), so the first row
 *     for a cleaned name keeps that trigger. Later rows that collapse to the
 *     same name are retained as slash-only commands under deterministic
 *     suffixed names; only one command can own the member-visible trigger.
 *
 * The importer never POSTs anything: it writes definitions. Firing them is
 * the scheduler's and gateway's job, same as admin-defined ones.
 */

/**
 * MEE6 placeholder -> Owen placeholder. `{user}` in MEE6 mentions the user;
 * our `{user}` does too. Anything not in this map is removed.
 */
const MEE6_PLACEHOLDER_MAP: Record<string, string> = {
  user: 'user',
  username: 'username',
  server: 'server',
  guild: 'server',
  channel: 'channel',
};

/** Clean an MEE6 command name into an Owen one. */
export function cleanMee6Name(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return cleaned;
}

/** Translate one MEE6 response into an Owen template. */
export function translateMee6Template(raw: string): string {
  return raw.replace(/\{([^{}]+)\}/g, (_whole, key: string) => {
    const mapped = /^[a-zA-Z0-9_]+$/.test(key)
      ? MEE6_PLACEHOLDER_MAP[key.toLowerCase()]
      : undefined;
    if (mapped) return `{${mapped}}`;
    // Unknown MEE6 placeholder, including punctuation-bearing forms: drop it
    // rather than leak MEE6 syntax into a member-facing reply.
    return '';
  });
}

export interface Mee6CommandInput {
  command: string;
  description?: string;
  response: string;
}

export interface TranslatedCommand {
  name: string;
  description: string;
  template: string;
  textTrigger: string | null;
}

export interface TranslatedExport {
  commands: TranslatedCommand[];
  conflicts: string[];
}

/**
 * Parse a MEE6 export body. Throws on anything that is not an array of
 * command-shaped objects; returns the raw inputs, translation happens in
 * translateExport so each step is testable alone.
 */
export function parseMee6Export(body: unknown): Mee6CommandInput[] {
  if (!Array.isArray(body)) {
    throw new Error('MEE6 export must be a JSON array of commands.');
  }
  const out: Mee6CommandInput[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('MEE6 export entries must be objects.');
    }
    const e = entry as Record<string, unknown>;
    const command = e.command ?? e.name;
    const response = e.response ?? e.message ?? e.content;
    if (typeof command !== 'string' || typeof response !== 'string') {
      throw new Error('MEE6 export entries need string "command" and "response" fields.');
    }
    out.push({
      command,
      description: typeof e.description === 'string' ? e.description : '',
      response,
    });
  }
  return out;
}

/**
 * Translate a parsed export into stable Owen definitions.
 *
 * The first cleaned MEE6 name remains both slash name and text trigger. Later
 * collisions keep their definitions as slash-only commands with deterministic
 * numeric suffixes. The conflict list tells admins which source names no longer
 * have a text trigger, without discarding valid command content.
 */
export function translateExport(parsed: Mee6CommandInput[]): TranslatedExport {
  const commands: TranslatedCommand[] = [];
  const conflicts: string[] = [];
  const counts = new Map<string, number>();
  const usedNames = new Set<string>();

  for (const item of parsed) {
    const baseName = cleanMee6Name(item.command);
    if (!baseName) continue; // a command whose name cleans to nothing cannot be invoked

    const occurrence = (counts.get(baseName) ?? 0) + 1;
    counts.set(baseName, occurrence);
    let name = baseName;
    if (occurrence > 1 || usedNames.has(name)) {
      conflicts.push(baseName);
      let suffix = occurrence;
      do {
        const suffixText = `-${suffix}`;
        name = `${baseName.slice(0, 32 - suffixText.length)}${suffixText}`;
        suffix++;
      } while (usedNames.has(name));
    }
    usedNames.add(name);

    commands.push({
      name,
      description: (item.description || `Imported from MEE6`).slice(0, 100),
      template: translateMee6Template(item.response).slice(0, 2000),
      textTrigger: occurrence === 1 ? `!${baseName}` : null,
    });
  }
  return { commands, conflicts };
}

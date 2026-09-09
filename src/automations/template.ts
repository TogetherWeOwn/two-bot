/**
 * The custom-command template language (TOG-1648).
 *
 * MEE6's placeholders, minus the ones that would need data the bot
 * deliberately does not hold (no avatar URLs, no member counts by role):
 *
 *   {user}      - the invoking member's display mention
 *   {username}  - their plain username, no mention ping
 *   {server}    - the guild's name
 *   {channel}   - the channel the command ran in
 *
 * Unknown placeholders are an error at definition time, not a silent blank at
 * run time: a typo'd `{usre}` reaching production and rendering literally in
 * front of members is exactly the failure validation exists to prevent.
 *
 * Rendered output is capped at Discord's 2000-character message ceiling. The
 * database CHECK enforces it on the stored template; the rendered form can
 * exceed it (username + template), so the check happens again here, after
 * substitution.
 */

export const TEMPLATE_PLACEHOLDERS = ['user', 'username', 'server', 'channel'] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{([a-z]+)\}/g;
export const MAX_RENDERED_CHARS = 2000;

export interface TemplateContext {
  user: string;
  username: string;
  server: string;
  channel: string;
}

/** Every placeholder the template references, deduplicated. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_PATTERN)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Validate at definition time. Throws Error with a member-facing message;
 * the command layer catches and shows it to the admin defining the command.
 */
export function validateTemplate(template: string): void {
  if (template.length < 1 || template.length > 2000) {
    throw new Error('Template must be between 1 and 2000 characters.');
  }
  const unknown = placeholdersIn(template).filter(
    (p) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(p),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown placeholder {${unknown[0]}}. Supported: ${TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
    );
  }
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  const out = template.replace(PLACEHOLDER_PATTERN, (_, key: string) => {
    const value = (ctx as unknown as Record<string, string>)[key];
    return value !== undefined ? value : `{${key}}`;
  });
  if (out.length > MAX_RENDERED_CHARS) {
    throw new Error(
      `Rendered command output is ${out.length} characters; Discord's ceiling is ${MAX_RENDERED_CHARS}.`,
    );
  }
  return out;
}

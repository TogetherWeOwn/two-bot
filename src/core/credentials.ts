/**
 * Read a secret from systemd's credential directory, falling back to the
 * environment.
 *
 * Why this exists: the bot is going onto a machine it shares with the website,
 * Postgres and staging. `EnvironmentFile=` puts the token in the process
 * environment, which means it is also in `/proc/<pid>/environ`, in any child
 * process the bot spawns, and in a core dump. systemd `LoadCredential=` puts it
 * in a `0400` file under a private per-service directory instead, so it is
 * readable by exactly one Unix user and never appears in the environment at
 * all. On a single-purpose box that difference is academic. On a shared box it
 * is the difference between "the web user cannot read the token" being a fact
 * and being a hope.
 *
 * It stops non-root processes. It does not stop root; nothing does. See the
 * `hosting-decision` document on TWO-37.
 *
 * Precedence is credential file first, then environment, so a box that has been
 * migrated to credentials cannot silently fall back to a stale env value.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CredentialSource {
  /** Usually `$CREDENTIALS_DIRECTORY`, set by systemd. Null = not running under it. */
  dir: string | null;
  env: NodeJS.ProcessEnv;
}

export function credentialSource(env: NodeJS.ProcessEnv = process.env): CredentialSource {
  return { dir: env.CREDENTIALS_DIRECTORY || null, env };
}

/**
 * Look up `name` as a systemd credential, then each of `envNames` in order.
 * Returns null when none of them are set.
 *
 * A credential file that exists but is empty or whitespace counts as unset, so
 * a truncated `LoadCredential` write falls through to the environment rather
 * than starting the bot with an empty token and a confusing Discord 401.
 */
export function readSecret(
  name: string,
  envNames: string[],
  source: CredentialSource = credentialSource(),
): string | null {
  if (source.dir) {
    try {
      const v = readFileSync(join(source.dir, name), 'utf8').trim();
      if (v) return v;
    } catch (err) {
      // ENOENT is ordinary: not every credential is provisioned on every host.
      // Anything else (EACCES on a mis-chowned file, EISDIR) is worth knowing
      // about, but it must never print the path's contents.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`Credential "${name}" exists but could not be read (${code}).`);
      }
    }
  }
  for (const n of envNames) {
    const v = source.env[n];
    if (v) return v;
  }
  return null;
}

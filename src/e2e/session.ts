/**
 * Opening and closing the one end-to-end harness session (TOG-3978).
 *
 * THE SESSION IS A SINGLETON ON PURPOSE. The owner's condition is one
 * persistent session, and the reason is not politeness: a user account that
 * appears on the gateway from two places at once, repeatedly, is the single
 * most legible automation signal there is. `openSession` therefore refuses the
 * second caller rather than queueing it, because a queue would make two
 * concurrent runs look like one slow run and hide the mistake.
 *
 * THE FENCE IS ON THE GUILD, NOT ON INTENT. Every entry point here checks the
 * guild id against `src/staging/spec.ts` before anything else, and names the
 * live guild explicitly so "we pointed it at production" is a distinct,
 * readable refusal rather than a generic one. Live-guild use needs a new owner
 * decision; until it exists, this file is where that decision is enforced.
 *
 * THE TOKEN NEVER LEAVES THIS FUNCTION'S ARGUMENTS. It is read from the
 * environment (or a systemd credential) and handed straight to the transport
 * factory. It is not stored on the session, not logged, and not returned, so
 * the object a runner holds cannot leak it into a transcript by accident.
 *
 * CLOSE TEARS DOWN THE TRANSPORT (TOG-4122). `close()` calls the transport's
 * optional `close()` after releasing the singleton, so a throwing teardown
 * cannot strand the process, and calling it twice tears down once.
 *
 * CONNECT FAILURES ARE SANITIZED (TOG-4122). Whatever the client library threw
 * - URLs, statuses, stack internals - is dropped and replaced with one static
 * refusal, because a connection error is the most likely place for a credential
 * or network detail to hide, and the refusal is printed to the operator console.
 */

import { readSecret, credentialSource, type CredentialSource } from '../core/credentials.ts';
import { LIVE_GUILD_ID, LIVE_GUILD_NAME, TWO_STAGING_GUILD_ID } from '../staging/spec.ts';
import { HarnessGuard, type GuardOptions } from './guard.ts';
import type { HarnessTransport } from './transport.ts';

/**
 * The env var the harness reads. Named for what it is so nobody confuses it
 * with `DISCORD_TOKEN`: this is a USER credential and the bot must never be
 * started with it, nor it with the bot's.
 */
export const E2E_TOKEN_ENV = 'TWO_E2E_USER_TOKEN';
/** The matching systemd credential name, same precedence rules as the bot's token. */
export const E2E_TOKEN_CREDENTIAL = 'two_e2e_user_token';

export interface HarnessSession {
  guard: HarnessGuard;
  transport: HarnessTransport;
  guildId: string;
  close(): void;
}

export interface OpenSessionOptions {
  guildId: string;
  /** Builds the live client. Receives the token and must not retain it anywhere loggable. */
  connect(token: string): Promise<HarnessTransport> | HarnessTransport;
  guard?: GuardOptions;
  /** Injected by tests; defaults to the real environment. */
  credentials?: CredentialSource;
}

/**
 * Refuse any guild that is not TWO Staging.
 *
 * Exported because the kill switch and the runner both need the same answer,
 * and two copies of a fence is one fence.
 */
export function assertStagingGuild(guildId: string): void {
  if (guildId === LIVE_GUILD_ID) {
    throw new Error(
      `e2e harness refused: ${guildId} is the live guild (${LIVE_GUILD_NAME}). ` +
        'This harness is approved for staging only; live use needs a new owner decision (TOG-3978).',
    );
  }
  if (guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(
      `e2e harness refused: ${guildId} is not the staging guild pinned in src/staging/spec.ts.`,
    );
  }
}

// Module-level because the constraint is per process, which is what one
// persistent session means. `close()` is the only way to clear it.
let openSessionLabel: string | null = null;

/** True while a session is open. Exists so tests can assert close() actually closed. */
export function sessionIsOpen(): boolean {
  return openSessionLabel !== null;
}

export async function openSession(o: OpenSessionOptions): Promise<HarnessSession> {
  assertStagingGuild(o.guildId);

  if (openSessionLabel) {
    throw new Error(
      `e2e harness refused: a session is already open (${openSessionLabel}). ` +
        'One persistent session per process is an owner condition (TOG-3978).',
    );
  }

  const token = readSecret(
    E2E_TOKEN_CREDENTIAL,
    [E2E_TOKEN_ENV],
    o.credentials ?? credentialSource(),
  );
  if (!token) {
    throw new Error(
      `e2e harness refused: no credential. Set ${E2E_TOKEN_ENV} (or provide the ` +
        `${E2E_TOKEN_CREDENTIAL} systemd credential). It is never read from a file in this repo.`,
    );
  }

  const label = `guild ${o.guildId} at ${new Date().toISOString()}`;
  openSessionLabel = label;
  let transport: HarnessTransport;
  try {
    transport = await o.connect(token);
  } catch {
    // A failed connect must not leave the singleton claimed, or the next run
    // in the same process is refused for a session that does not exist. The
    // library's error is dropped, not forwarded: connect failures are the most
    // likely place for a credential, URL or stack internal to hide, and this
    // refusal is printed to the operator console.
    openSessionLabel = null;
    throw new Error(
      'e2e harness refused: the connection failed before any action. ' +
        'Stop and report the failure; do not automatically retry.',
    );
  }

  let closed = false;
  return {
    guard: new HarnessGuard(o.guard),
    transport,
    guildId: o.guildId,
    close() {
      // Not ours (already closed): do nothing, notably do not tear down the
      // transport a second time.
      if (closed) return;
      closed = true;
      // Released BEFORE the teardown, so a throwing close cannot strand the
      // process singleton. The teardown itself is swallowed for the same
      // reason this file's callers invoke it from `finally`: a teardown
      // failure must never mask the run's own outcome, nor leak library
      // internals onto the console.
      openSessionLabel = null;
      try {
        transport.close?.();
      } catch {
        // Already released above; nothing left to do safely.
      }
    },
  };
}

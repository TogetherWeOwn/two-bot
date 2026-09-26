/**
 * Stubbed onboarding picker-copy + empty-states fixture with preview (TOG-4962).
 *
 * two-web's onboarding slice needs the picker's copy and its empty states
 * without a live guild, a bot token, or Discord. This module is that half:
 * the picker document shape two-web renders, the copy it renders (pinned to
 * the bot's real strings by execution, not by copy-paste), the preview-flag
 * gate that keeps the new copy off production, and a standalone HTML renderer
 * per UI state. No database, no network - data in, decisions out.
 *
 * THE CONTRACT, in one place. The document carries the heading, intro,
 * placeholder, options, and the empty-state title/body. The ack texts for the
 * picked/unavailable/stale branches are computed from `sessionAckText` over a
 * fake two-option catalog, so if the bot's wording moves this fixture - and
 * the test below - fails instead of drifting silently.
 *
 * NOTHING HERE IS A REAL ROOM. The channel ids are repeated fours and fives:
 * snowflake-shaped so shape checks pass, unallocatable by Discord, greppable.
 * The member mention in previews is the literal string `@member` for the same
 * reason - no real person, nothing to resolve.
 */
import {
  buildSessionPicks,
  planSession,
  sessionAckText,
  sessionWelcomeText,
  type SessionPick,
} from '../../src/onboarding/session.ts';

/** Env flag gating the new picker copy. Off unless exactly `1`. */
export const ONBOARDING_PICKER_PREVIEW_FLAG = 'TWO_ONBOARDING_PICKER_PREVIEW';

export function pickerPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ONBOARDING_PICKER_PREVIEW_FLAG] === '1';
}

/** The five UI states the acceptance greps for. */
export type PickerUiState = 'loading' | 'empty' | 'picked' | 'unavailable' | 'stale';

export const PICKER_STATES: ReadonlyArray<PickerUiState> = [
  'loading',
  'empty',
  'picked',
  'unavailable',
  'stale',
];

export interface PickerOption {
  key: string;
  label: string;
  description: string;
  emoji: string;
}

/**
 * The picker document two-web renders. `options` is empty exactly when the
 * empty state shows - no options and an empty state disagreeing is a contract
 * violation, and `pickerProblems` says so.
 */
export interface PickerDocument {
  heading: string;
  intro: string;
  placeholder: string;
  options: PickerOption[];
  emptyTitle: string;
  emptyBody: string;
}

export const PICKER_FIXTURE_CHANNEL_LOOKING = '444444444444444444';
export const PICKER_FIXTURE_CHANNEL_LOBBY = '555555555555555555';

const FAKE_CATALOG: SessionPick[] = buildSessionPicks({
  lookingToPlay: PICKER_FIXTURE_CHANNEL_LOOKING,
  lobbyVoice: PICKER_FIXTURE_CHANNEL_LOBBY,
});

function toOption(p: SessionPick): PickerOption {
  return { key: p.key, label: p.label, description: p.description, emoji: p.emoji };
}

/**
 * The ack text for a submission, computed from the real `planSession` +
 * `sessionAckText` over the fake catalog. `visible` is the whole test matrix:
 * all-visible routes, none-visible is unavailable, unknown keys are stale.
 */
export function ackFor(keys: string[], visible: (channelId: string) => boolean): string {
  return sessionAckText(planSession(keys, visible, FAKE_CATALOG));
}

/** The routed ack: every room open. Pinned to the bot's wording by execution. */
export function routedAck(): string {
  return ackFor(['find-players'], () => true);
}

/** The unavailable ack: no room open. Pinned to the bot's wording by execution. */
export function unavailableAck(): string {
  return ackFor(['find-players'], () => false);
}

/** The stale ack: the option is gone. Pinned to the bot's wording by execution. */
export function staleAck(): string {
  return ackFor(['no-such-option'], () => true);
}

const WELCOME_PROBE = sessionWelcomeText('@member');

/**
 * The picker before anything loads: no options yet, so the empty-state copy
 * must already be present - a blank panel with no explanation is the failure
 * this slice exists to prevent.
 */
export function emptyPicker(): PickerDocument {
  return {
    heading: "You're in - that was the whole application.",
    intro:
      'What do you want to do right now? Pick below and I will point you at the right room. ' +
      'You can change your mind any time - this picks a destination for tonight, not a label forever.',
    placeholder: 'What do you want to do right now?',
    options: [],
    emptyTitle: 'Nothing to pick right now.',
    emptyBody:
      'Every room this picker could point you at is closed to you at the moment. ' +
      'Nothing was changed - try again in a moment, or say hello in the welcome channel and someone will grab you.',
  };
}

/** The picker with the session catalog behind it: the two real options. */
export function sessionPicker(): PickerDocument {
  return { ...emptyPicker(), options: FAKE_CATALOG.map(toOption) };
}

/**
 * The contract check, as a pure function returning problems (empty = valid) -
 * the same shape as `check()` in scripts/require-suites.ts, so a test can
 * assert the exact failure instead of only that something threw.
 */
export function pickerProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['picker must be a JSON object'];
  }
  const problems: string[] = [];
  const body = value as Partial<PickerDocument>;
  for (const field of ['heading', 'intro', 'placeholder', 'emptyTitle', 'emptyBody'] as const) {
    if (typeof body[field] !== 'string' || body[field].trim().length === 0) {
      problems.push(`${field} must be a non-empty string, got ${JSON.stringify(body[field])}`);
    }
  }
  if (!Array.isArray(body.options)) {
    problems.push(`options must be an array, got ${JSON.stringify(body.options)}`);
    return problems;
  }
  for (const [index, option] of body.options.entries()) {
    if (!option || typeof option !== 'object') {
      problems.push(`options[${index}] must be an object`);
      continue;
    }
    const o = option as Partial<PickerOption>;
    for (const field of ['key', 'label', 'description', 'emoji'] as const) {
      if (typeof o[field] !== 'string' || o[field].length === 0) {
        problems.push(`options[${index}].${field} must be a non-empty string`);
      }
    }
  }
  if (body.options.length === 0 && (body.emptyTitle ?? '').trim().length === 0) {
    problems.push('a picker with no options must carry the empty-state copy');
  }
  return problems;
}

/** Copy-agreement probes: the fixture strings the bot must still contain. */
export function pickerCopyProbes(): { heading: string; introLead: string; placeholder: string } {
  return {
    heading: "you're in - that was the whole application.",
    introLead: 'What do you want to do right now?',
    placeholder: 'What do you want to do right now?',
  };
}

export { WELCOME_PROBE };

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One state's preview as a standalone document, served by
 * tools/onboarding-picker-preview/run.ts and asserted by the component test.
 * Only the requested branch renders: loading while the stub has not answered
 * yet, empty when it answered with no options, picked/unavailable/stale for
 * the three ack branches of `sessionAckText`.
 */
export function renderPickerPreview(state: PickerUiState, picker: PickerDocument | null): string {
  const shown = picker ?? emptyPicker();
  const options = shown.options
    .map(
      (o) =>
        `         <li data-testid="picker-option" data-key="${escapeHtml(o.key)}">${escapeHtml(o.emoji)} <strong>${escapeHtml(o.label)}</strong> &mdash; ${escapeHtml(o.description)}</li>`,
    )
    .join('\n');
  const body =
    state === 'loading'
      ? `<p role="status" data-testid="picker-loading">Loading picker&hellip;</p>`
      : state === 'empty'
        ? `<h2 data-testid="picker-empty-title">${escapeHtml(shown.emptyTitle)}</h2>\n       <p data-testid="picker-empty-body">${escapeHtml(shown.emptyBody)}</p>`
        : state === 'picked'
          ? `<p role="status" data-testid="picker-ack">${escapeHtml(routedAck())}</p>`
          : state === 'unavailable'
            ? `<p role="status" data-testid="picker-ack">${escapeHtml(unavailableAck())}</p>`
            : `<p role="alert" data-testid="picker-ack">${escapeHtml(staleAck())}</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Onboarding picker preview (${state})</title></head>
<body>
<main data-state="${state}">
<h1>${escapeHtml(shown.heading)}</h1>
<p>${escapeHtml(shown.intro)}</p>
<p><em>${escapeHtml(shown.placeholder)}</em></p>
${shown.options.length > 0 ? `       <ul>\n${options}\n       </ul>` : ''}
${body}
</main>
</body>
</html>
`;
}

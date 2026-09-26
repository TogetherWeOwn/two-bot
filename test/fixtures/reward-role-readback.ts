/**
 * Stubbed reward-role readback fixture plus the three-state preview (TOG-5161).
 *
 * The staging grant/readback/revoke path (TOG-4444) needs a live guild, a bot
 * token and a disposable member. QA's readback-UX acceptance (TOG-5107) does
 * not: it needs the endpoint shape and the three UI states, and it needs them
 * without touching Discord. This module is that half, with no database and no
 * network - data in, decisions out, the way `rewardImport.ts` is pure.
 *
 * THE CONTRACT, in one place. TOG-5107 step 1 validates two JSON documents:
 * an empty readback (`grants: []`) and a granted one (one or more grants with
 * `roleId` + `level`). The defaults below use the same member and role ids as
 * that script, so the fixture here and the acceptance there agree
 * byte-for-byte instead of each inventing its own "test user".
 *
 * NOTHING HERE IS A REAL PERSON. The member id is eleven repeated ones and
 * the role id is eighteen repeated twos - both in the snowflake shape so the
 * shape checks pass, both unallocatable by Discord, both greppable.
 */
export interface ReadbackGrant {
  roleId: string;
  level: number;
  grantedAt: string;
}

export interface ReadbackResponse {
  member: string;
  grants: ReadbackGrant[];
}

/** The three UI states TOG-5107 step 2 greps for: loading, empty, granted. */
export type ReadbackUiState = 'loading' | 'empty' | 'granted';

export const READBACK_FIXTURE_MEMBER = '111111111111111111';
export const READBACK_FIXTURE_ROLE = '222222222222222222';
export const READBACK_FIXTURE_LEVEL = 5;
export const READBACK_FIXTURE_GRANTED_AT = '2026-09-26T00:00:00.000Z';

/** The readback before any grant: the member holds no reward roles. */
export function emptyReadback(member: string = READBACK_FIXTURE_MEMBER): ReadbackResponse {
  return { member, grants: [] };
}

/** The readback after an apply: the member holds the fixture reward role. */
export function grantedReadback(
  member: string = READBACK_FIXTURE_MEMBER,
  grant: Partial<ReadbackGrant> = {},
): ReadbackResponse {
  return {
    member,
    grants: [
      {
        roleId: grant.roleId ?? READBACK_FIXTURE_ROLE,
        level: grant.level ?? READBACK_FIXTURE_LEVEL,
        grantedAt: grant.grantedAt ?? READBACK_FIXTURE_GRANTED_AT,
      },
    ],
  };
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The contract check, as a pure function returning problems (empty = valid) -
 * the same shape as `check()` in scripts/require-suites.ts, so a test can
 * assert the exact failure instead of only that something threw.
 */
export function readbackProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['readback must be a JSON object'];
  }
  const problems: string[] = [];
  const body = value as Partial<ReadbackResponse>;
  if (typeof body.member !== 'string' || !SNOWFLAKE.test(body.member)) {
    problems.push(`member must be a Discord snowflake string, got ${JSON.stringify(body.member)}`);
  }
  if (!Array.isArray(body.grants)) {
    problems.push(`grants must be an array, got ${JSON.stringify(body.grants)}`);
    return problems;
  }
  for (const [index, grant] of body.grants.entries()) {
    if (!grant || typeof grant !== 'object') {
      problems.push(`grants[${index}] must be an object`);
      continue;
    }
    const g = grant as Partial<ReadbackGrant>;
    if (typeof g.roleId !== 'string' || !SNOWFLAKE.test(g.roleId)) {
      problems.push(`grants[${index}].roleId must be a Discord snowflake string`);
    }
    if (!Number.isInteger(g.level) || (g.level as number) <= 0) {
      problems.push(`grants[${index}].level must be a positive integer`);
    }
    if (typeof g.grantedAt !== 'string' || Number.isNaN(Date.parse(g.grantedAt))) {
      problems.push(`grants[${index}].grantedAt must be an ISO instant`);
    }
  }
  return problems;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One state's preview as a standalone document, served by
 * tools/reward-role-readback-preview/run.ts and asserted by the component
 * test. Only the requested branch renders: the loading branch while the stub
 * has not answered yet, the empty branch when it answered with no grants, the
 * granted branch when a reward role reads back after apply.
 */
export function renderReadbackPreview(
  state: ReadbackUiState,
  readback: ReadbackResponse | null,
): string {
  const shown = readback ?? emptyReadback();
  const body =
    state === 'loading'
      ? `<p role="status">Loading grant state&hellip;</p>`
      : state === 'empty'
        ? `<p>No reward roles on this member yet &mdash; the grant list is empty.</p>`
        : `<p>Granted reward roles (${shown.grants.length}):</p>
       <ul>
${shown.grants.map((g) => `         <li>level ${g.level} &mdash; <code>${escapeHtml(g.roleId)}</code> (granted ${escapeHtml(g.grantedAt)})</li>`).join('\n')}
       </ul>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Reward-role readback preview (${state})</title></head>
<body>
<main data-state="${state}">
<h1>Reward-role grant state: ${state}</h1>
<p>Member <code>${escapeHtml(shown.member)}</code></p>
${body}
</main>
</body>
</html>
`;
}

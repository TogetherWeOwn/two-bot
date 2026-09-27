/**
 * The fetch-driven reward-role readback panel (TOG-4837).
 *
 * TOG-4444 built the staging grant/readback/revoke path against Discord; the
 * website still shows nothing after an apply. This module is the UI half of
 * that gap: fetch one member's readback from a stubbed endpoint and render
 * the three states QA greps for (TOG-5107 step 2) - `loading` while the stub
 * has not answered, `empty` when it answered with no grants, `granted` when
 * a reward role reads back after apply.
 *
 * This is deliberately separate from TOG-5161's static preview renderer,
 * which renders a caller-chosen state without fetching. That fixture proves
 * the shapes; this panel proves the fetch-then-render loop, including the
 * re-read that flips `empty` to `granted` after an apply.
 *
 * THE CONTRACT, pinned to TOG-5107 step 1 (not to any implementation): the
 * stub serves `{member, grants[]}` where every grant carries `roleId` +
 * `level` (+ `grantedAt`). The test asserts the stub bodies agree with that
 * script's heredocs shape-for-shape on parsed values, so if the envelope
 * ever moves, both change together instead of drifting apart.
 *
 * STAGING-ONLY, OFFLINE, NO PRODUCTION. The module never constructs a URL -
 * the caller passes the stub (tests) or staging (QA) endpoint in, and only
 * `http(s)` is fetched. It holds no guild id, no token, no database: data
 * in, decisions out. Nothing here is a real person - the member id is
 * eighteen repeated ones and the role id eighteen repeated twos, both in the
 * snowflake shape so the shape checks pass, both unallocatable by Discord,
 * both greppable. `loadReadback` is fail-closed: a non-200, a non-JSON body
 * or a contract violation throws naming the problem, never a half-render.
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

export const READBACK_PANEL_MEMBER = '111111111111111111';
export const READBACK_PANEL_ROLE = '222222222222222222';
export const READBACK_PANEL_LEVEL = 5;
export const READBACK_PANEL_GRANTED_AT = '2026-09-26T00:00:00.000Z';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The contract check, as a pure function returning problems (empty = valid):
 * the member must read as a Discord id, grants must be an array, and every
 * grant needs a role id, a positive level and an ISO instant. Malformed
 * input names what is wrong instead of throwing, so the fetch half can quote
 * it in its refusal.
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

/** A readback with no grants is the empty state; any grant is the granted one. */
export function stateForReadback(readback: ReadbackResponse): 'empty' | 'granted' {
  return readback.grants.length === 0 ? 'empty' : 'granted';
}

/**
 * Fetch one member's readback and validate it against the contract. The fetch
 * implementation is injected (tests pass the global fetch pointed at a
 * loopback stub; QA passes it pointed at staging), so this function never
 * decides which endpoint is the right one - it only refuses to fetch
 * non-HTTP(S) and refuses to return a body that fails the contract.
 */
export async function loadReadback(
  fetchImpl: typeof fetch,
  url: string,
): Promise<ReadbackResponse> {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`readback panel refuses non-HTTP(S) endpoint: ${url || '(empty)'}`);
  }
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`readback endpoint unreachable at ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`readback endpoint answered HTTP ${res.status} at ${url}; refusing to render`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new Error(`readback endpoint at ${url} did not answer JSON; refusing to render`);
  }
  const problems = readbackProblems(body);
  if (problems.length > 0) {
    throw new Error(`readback at ${url} violates the contract: ${problems.join('; ')}`);
  }
  return body as ReadbackResponse;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One state's panel as a standalone document. Only the requested branch
 * renders: the loading branch while the stub has not answered yet (no
 * readback needed), the empty branch when it answered with no grants, the
 * granted branch when a reward role reads back after apply. Rendering never
 * validates - `loadReadback` already refused anything invalid - but it always
 * escapes, because the member id on a real endpoint is member-supplied.
 */
export function renderReadbackPanel(state: ReadbackUiState, readback: ReadbackResponse | null): string {
  const shown: ReadbackResponse =
    readback ?? { member: READBACK_PANEL_MEMBER, grants: [] };
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
<head><meta charset="utf-8"><title>Reward-role readback (${state})</title></head>
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

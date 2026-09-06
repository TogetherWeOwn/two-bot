/**
 * "Is the growth gate green, and if not, which criterion failed and who owns it?"
 *
 * The founder's decision of 20 August 2026 (document `event-go-no-go` §0,
 * TWO-62 / TOG-92) gated every outward-facing growth channel on six criteria -
 * three for the bot, three for the website. All six required. **Five of six is
 * red.** The Chief of Staff checks them every Friday 21:00 UK, and the weekly
 * scoring loop in TOG-92 does not start until a check comes back green.
 *
 * Until now that check was prose. Someone read `event-go-no-go` §1, formed a
 * view on each line, and wrote a comment. That is six judgement calls re-made
 * from scratch every week by whoever is awake, and it has already produced the
 * failure it was always going to produce: a run that reported the gate red,
 * named no criterion, and left no artifact anyone could re-run. The rules have
 * numbers in them, so they belong in code - same input, same answer, forever.
 *
 * WHAT THIS IS AND IS NOT
 *
 * This module is pure: it maps observations to verdicts and owners, and does no
 * I/O. `scripts/gate-check.ts` does the looking - HTTP, database, Discord - and
 * hands the results here. Same split as `staging/readiness.ts`, and for the same
 * reason: the arithmetic gets a unit test that needs no network, no token and no
 * live guild, so the rule can be verified on a laptop while the gate is red.
 *
 * It does NOT decide whether to run the event. It reports the six facts. The
 * Friday call, and naming the Sunday, stay with the Chief of Staff.
 *
 * THE TRAP THIS EXISTS TO STOP
 *
 * An `unknown` observation is NOT a pass. When a criterion cannot be measured -
 * no token bound, no database URL, the domain unreachable - the honest verdict
 * is `unknown`, and `verdict()` treats it exactly as hard as a `fail`, because
 * a gate that goes green on six shrugs is worse than no gate. The one thing
 * this must never do is let "we could not check" read as "it is fine".
 */

/**
 * ok      - observably true. Not "merged", not "nearly".
 * fail    - observably false. Someone owns making it true.
 * unknown - could not be measured from here. Counts as red, never as green.
 */
export type CriterionStatus = 'ok' | 'fail' | 'unknown';

export type CriterionId =
  | 'bot-service'
  | 'bot-attributed-join'
  | 'bot-welcome'
  | 'web-domain'
  | 'web-join-button'
  | 'web-code-row';

export type Side = 'bot' | 'website';

export interface Criterion {
  id: CriterionId;
  side: Side;
  /** The criterion as `event-go-no-go` §1 words it. Kept verbatim so the report and the doc cannot drift. */
  title: string;
  status: CriterionStatus;
  /** What is true right now. One line, no secrets, no token, no member identities. */
  detail: string;
  /** Who can make this ok. Required on anything that is not `ok`. */
  owner?: string;
  /** The exact next step - a command, or the ask to put in front of the owner. */
  action?: string;
}

/**
 * What the script managed to observe. Every field is optional and `undefined`
 * means "not measured" rather than "false" - the distinction the whole module
 * turns on. A boolean here is a fact someone looked at; `undefined` is a gap.
 */
export interface Observations {
  /**
   * The bot process is up and connected on the live host.
   *
   * Deliberately not "systemctl reports active". TOG-13 shipped the bot as a
   * Coolify container on the owner's VPS (`two-bot-dk`), not as a systemd unit,
   * so `systemctl` is the wrong instrument on the deployment we actually have.
   * The criterion is the fact - a running, Discord-connected process - and the
   * caller reports whichever way it looked.
   */
  serviceActive?: boolean;
  /** Why the service could not be checked, when it could not be. */
  serviceDetail?: string;
  /** Joins on file that carry a real invite code, excluding `TEST` and backfill rows. */
  attributedJoins?: number;
  /** Why the funnel could not be read, when it could not be. */
  funnelDetail?: string;
  /** A test account cleared the rules gate and received the routed welcome (TWO-69 item 1). */
  welcomeDelivered?: boolean;
  welcomeDetail?: string;
  /** Phase 1 answered on the real domain - a 2xx from the apex, not a preview URL. */
  domainLive?: boolean;
  /** What the apex actually returned, e.g. `403, redirected to togetherweown.com`. */
  domainDetail?: string;
  /** The landing page rendered and the tracked join button resolved end to end. */
  joinButtonWorks?: boolean;
  joinButtonDetail?: string;
  /** `WEB-HOMEPAGE` appeared in the funnel report as its own row. */
  webCodeRowPresent?: boolean;
  webCodeRowDetail?: string;
}

/**
 * The website join button's invite code. Ledger §1a consequence 2: this is both
 * EXP-006's code and website criterion 3, which is why the lowest-stakes entry
 * in the ledger sits on the critical path for every other experiment.
 */
export const WEB_HOMEPAGE_CODE = 'WEB-HOMEPAGE';

// TOG-13 (live token + host + deploy) closed 2026-09-06: `two-bot-dk` runs on
// the Coolify VPS as `Owen#2309`. The bot side is no longer blocked on a deploy
// that does not exist - it is blocked on OBSERVING the deploy we have, which is
// a different ask and a different owner action. Naming a closed card as the
// blocker is how a gate keeps reporting last month's reason.
const BOT_OWNER = 'Backend/Bot Engineer (two-bot-dk on Coolify - observe the running container)';
const WEB_OWNER = 'Web team (TOG-48 landing page, TOG-47 Discord OAuth)';

/** `undefined` -> unknown, `true` -> ok, `false` -> fail. The whole point of the module in one line. */
function observed(
  value: boolean | undefined,
  base: Omit<Criterion, 'status' | 'detail'>,
  onOk: string,
  onFail: { detail: string; owner: string; action: string },
  onUnknown: { detail: string; owner: string; action: string },
): Criterion {
  if (value === true) return { ...base, status: 'ok', detail: onOk };
  if (value === false) return { ...base, status: 'fail', ...onFail };
  return { ...base, status: 'unknown', ...onUnknown };
}

export function botChecks(o: Observations): Criterion[] {
  const service = observed(
    o.serviceActive,
    { id: 'bot-service', side: 'bot', title: 'the bot process is running and connected on the live host' },
    'the bot process is running and connected to Discord.',
    {
      detail: o.serviceDetail ?? 'the bot is not running on the live host.',
      owner: BOT_OWNER,
      action: 'bash scripts/coolify-deploy.sh, then re-run this check',
    },
    {
      detail:
        o.serviceDetail ??
        'not observable from the agent runtime - no COOLIFY_URL/COOLIFY_TOKEN bound, so the container could not be polled.',
      owner: BOT_OWNER,
      action:
        'bind COOLIFY_URL + COOLIFY_TOKEN and re-run, or poll two-bot-dk logs twice ~70s apart and confirm the last line advances',
    },
  );

  // Criterion 2 is the one that decides whether the funnel collects anything at
  // all, so a zero here is a hard fail rather than a "not yet". Ledger §1a
  // consequence 3: the join that satisfies it will be a controlled TEST join,
  // and a TEST row is netted out before any code's joins are quoted - so the
  // count handed in here must already exclude them, or this passes on a staff
  // test dressed up as a channel result.
  const join = (() => {
    const base = {
      id: 'bot-attributed-join' as const,
      side: 'bot' as const,
      title: 'the funnel shows at least one real join attributed to a real invite code',
    };
    if (o.attributedJoins === undefined) {
      return {
        ...base,
        status: 'unknown' as const,
        detail: o.funnelDetail ?? 'the funnel could not be read - TWO_DATABASE_URL is not bound in this environment.',
        owner: BOT_OWNER,
        action: 'bind TWO_DATABASE_URL, then: npm run attribution -- all',
      };
    }
    if (o.attributedJoins > 0) {
      return {
        ...base,
        status: 'ok' as const,
        detail: `${o.attributedJoins} attributed join(s) on file, excluding TEST and backfill rows.`,
      };
    }
    return {
      ...base,
      status: 'fail' as const,
      // The observed shape of the table, not a remembered one. The 19 Aug
      // baseline's joins were all `backfill:*` rows, but asserting that here
      // would be quoting the ledger at a database nobody re-read.
      detail: o.funnelDetail
        ? `0 joins carry an invite code. ${o.funnelDetail}`
        : '0 joins carry an invite code - nothing on file is attributed to one.',
      owner: BOT_OWNER,
      action:
        'with the bot live, make one controlled join through a LEGACY-ORGANIC code and log it as a TEST row ' +
        'in registry §4a (ledger §1a consequence 3 - keep all 8 campaign codes at zero)',
    };
  })();

  const welcome = observed(
    o.welcomeDelivered,
    { id: 'bot-welcome', side: 'bot', title: 'a test account clearing the rules gate receives the routed welcome' },
    'the routed welcome was delivered and named the next Sunday Squad.',
    {
      detail: o.welcomeDetail ?? 'a test account cleared the rules gate and no routed welcome arrived.',
      owner: BOT_OWNER,
      action: 'check the TWO-69 onboarding handler against the live guild, then re-run',
    },
    {
      detail:
        o.welcomeDetail ??
        'the bot is live, but nobody has run a test account through the rules gate - this needs a human in Discord.',
      owner: BOT_OWNER,
      action: 'run one test account through the rules gate, then re-run with TWO_GATE_WELCOME_OK=1',
    },
  );

  return [service, join, welcome];
}

export function websiteChecks(o: Observations): Criterion[] {
  const domain = observed(
    o.domainLive,
    { id: 'web-domain', side: 'website', title: 'Phase 1 live on the real domain, not a preview URL' },
    o.domainDetail ?? 'the apex answers and serves Phase 1.',
    {
      detail: o.domainDetail ?? 'the real domain does not serve Phase 1.',
      owner: WEB_OWNER,
      action: 'ship Phase 1 to the apex domain (TOG-48), then re-run',
    },
    {
      detail: o.domainDetail ?? 'the domain could not be reached from here.',
      owner: WEB_OWNER,
      action: 're-run this check from a host with outbound network access',
    },
  );

  const button = observed(
    o.joinButtonWorks,
    { id: 'web-join-button', side: 'website', title: 'the landing page renders and the tracked join button works end to end' },
    'the landing page renders and the join button resolves to the tracked invite.',
    {
      detail: o.joinButtonDetail ?? 'the landing page or its tracked join button does not work end to end.',
      owner: WEB_OWNER,
      action: 'TOG-48 (landing page) and TOG-80 (one-click join), then re-run',
    },
    {
      detail:
        o.joinButtonDetail ??
        'no landing page to exercise - TOG-48 is blocked, so there is no button to click.',
      owner: WEB_OWNER,
      action: 'land TOG-48, then re-run',
    },
  );

  const row = observed(
    o.webCodeRowPresent,
    { id: 'web-code-row', side: 'website', title: `the join button's invite code appears in the funnel as its own row` },
    `${WEB_HOMEPAGE_CODE} appears in the funnel report as its own row.`,
    {
      detail: o.webCodeRowDetail ?? `${WEB_HOMEPAGE_CODE} is bound but has produced no row in the funnel report.`,
      owner: WEB_OWNER,
      action: 'confirm the join button issues the bound code, then: npm run attribution -- all',
    },
    {
      detail: o.webCodeRowDetail ?? 'the funnel could not be read - TWO_DATABASE_URL is not bound in this environment.',
      owner: WEB_OWNER,
      action: 'bind TWO_DATABASE_URL, then: npm run attribution -- all',
    },
  );

  return [domain, button, row];
}

export function allChecks(o: Observations): Criterion[] {
  return [...botChecks(o), ...websiteChecks(o)];
}

/**
 * `green` only when all six are `ok`. There is deliberately no partial verdict:
 * `event-go-no-go` §1 says "No partial credit on either side. Five of six is
 * red", and a gate that reports "nearly" is a gate someone talks past.
 */
export type GateVerdict = 'green' | 'red';

export function verdict(checks: Criterion[]): GateVerdict {
  return checks.every((c) => c.status === 'ok') ? 'green' : 'red';
}

/** The criteria standing between here and green, in report order. */
export function failing(checks: Criterion[]): Criterion[] {
  return checks.filter((c) => c.status !== 'ok');
}

/**
 * Exit codes: 0 green, 1 red. Red is a legitimate weekly outcome rather than a
 * malfunction, but it must not read as success to a caller that only checks the
 * status - so it is non-zero, and the reason is on stdout.
 */
export const EXIT_CODE: Readonly<Record<GateVerdict, number>> = { green: 0, red: 1 };

/**
 * Whether the TOG-92 weekly scoring loop should run this week.
 *
 * This is the question the issue actually asks, and it has exactly one correct
 * answer while the gate is red: no. Scoring a portfolio in which every channel
 * is at 0 joins and £0 spend produces a table of zeros and feeds the kill/scale
 * rules noise - and the rules are explicit that a channel is never killed on
 * one week, so a red-gate run cannot even produce a valid kill.
 */
export function scoringLoopRuns(v: GateVerdict): boolean {
  return v === 'green';
}

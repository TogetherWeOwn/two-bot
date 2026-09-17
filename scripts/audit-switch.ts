/**
 * Emergency kill switch for the audit mirror (TOG-3187).
 *
 *   node scripts/audit-switch.ts --halt [--by <who>]   stop all mirror sends + retries now
 *   node scripts/audit-switch.ts --resume              let held rows deliver again
 *   node scripts/audit-switch.ts --status              show the switch and what it holds
 *
 * Reads TWO_DATABASE_URL. The bot re-reads the switch before every Discord
 * send and once per pending row, so the effect is immediate - no restart, no
 * redeploy - and it survives one, because the switch is a row, not memory.
 * Durable audit rows are never touched by either direction; halting only
 * stops sends.
 *
 * Safe to run while the bot is up. openDb takes the migration advisory lock,
 * so a first run on a database that predates migration 0026 applies it here
 * rather than erroring on a missing table.
 */
import { hostname } from 'node:os';
import { openDb } from '../src/store/db.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';

const args = process.argv.slice(2);
const halt = args.includes('--halt');
const resume = args.includes('--resume');
const byIndex = args.indexOf('--by');
const engagedBy = byIndex !== -1 && args[byIndex + 1] ? args[byIndex + 1] : `operator@${hostname()}`;

if (Number(halt) + Number(resume) > 1) {
  console.error('audit-switch: pass exactly one of --halt or --resume.');
  process.exit(2);
}

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url) {
  console.error('audit-switch: TWO_DATABASE_URL is not set. See docs/RUNBOOK.md.');
  process.exit(1);
}

const db = await openDb(url, { applicationName: 'two-bot-audit-switch' });
const store = new OperationalAuditStore(db);

try {
  if (halt) {
    const won = await store.engageDeliveryHalt(engagedBy);
    console.log(won
      ? `audit-switch: KILL SWITCH ENGAGED by ${engagedBy}.`
      : 'audit-switch: kill switch was already engaged; nothing changed.');
  } else if (resume) {
    const won = await store.disengageDeliveryHalt();
    console.log(won
      ? 'audit-switch: KILL SWITCH DISENGAGED. Held rows deliver on the next sweep (<= 30s).'
      : 'audit-switch: kill switch was not engaged; nothing changed.');
  }

  const state = await store.deliveryHaltState();
  const counts = await db
    .prepare(
      `SELECT delivery_state, COUNT(*) AS n FROM operational_audit_log
        WHERE mirror_channel_id IS NOT NULL GROUP BY delivery_state`,
    )
    .all<{ delivery_state: string; n: number }>();
  const byState = new Map(counts.map((r) => [r.delivery_state, Number(r.n)]));
  const pending = byState.get('pending') ?? 0;

  if (state) {
    console.log(`state:    ENGAGED at ${state.engagedAt} by ${state.engagedBy}`);
    console.log(`pending:  ${pending} row(s) held for delivery (durable rows untouched)`);
  } else {
    console.log('state:    disengaged');
    console.log(`pending:  ${pending} row(s) awaiting the delivery sweep`);
  }
  console.log(`rows:     ${[...byState].map(([s, n]) => `${s}=${n}`).join(' ') || 'none'}`);
  if (!halt && !resume) console.log('undo:     --halt undoes --resume and vice versa; neither drops evidence.');
  process.exitCode = 0;
} finally {
  await db.close();
}

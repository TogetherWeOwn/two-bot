#!/usr/bin/env node
/**
 * Builds audit/role-consolidation.csv — the per-role diff behind the
 * `role-consolidation` document on TWO-55.
 *
 * No network. Reads the TWO-13 snapshot in audit/raw/ and nothing else, so the
 * rubric can be argued with and re-run for free. Every row is keyed by role id.
 *
 * Verdicts:
 *   keep      leave exactly as it is
 *   merge     holders get the survivor role first, then this one is deleted
 *   delete    removed; holder list exported first if it has any holders
 *   decision  CEO owns this one; `recommended` carries the default
 *   untouchable  owned by a bot integration — deleting the bot is the only way
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const raw = (f: string) => JSON.parse(readFileSync(resolve(ROOT, 'audit/raw', f), 'utf8'));

type Verdict = 'keep' | 'merge' | 'delete' | 'decision' | 'untouchable';

interface Plan {
  verdict: Verdict;
  group: string;
  /** role id of the survivor for `merge`, else '' */
  mergeInto?: string;
  /** for `decision` rows: what happens if the CEO just says yes to everything */
  recommended?: string;
  why: string;
}

const roles: any[] = raw('roles.json');
const channels: any[] = raw('channels.json');
const onboarding: any = raw('onboarding.json');
const members: any = raw('members.json');

const byId = new Map<string, any>(roles.map((r) => [r.id, r]));
const holders = (id: string): number => members.role_headcount[id] ?? 0;

// Role ids referenced by a channel/category permission overwrite (type 0 = role).
const overwrites = new Map<string, string[]>();
for (const c of channels) {
  for (const o of c.permission_overwrites ?? []) {
    if (Number(o.type) !== 0) continue;
    if (!overwrites.has(o.id)) overwrites.set(o.id, []);
    overwrites.get(o.id)!.push(c.name);
  }
}

// Role ids handed out by an onboarding prompt option, with the option that does it.
const grantedBy = new Map<string, string[]>();
for (const p of onboarding.prompts ?? []) {
  for (const opt of p.options ?? []) {
    for (const rid of opt.role_ids ?? []) {
      if (!grantedBy.has(rid)) grantedBy.set(rid, []);
      grantedBy.get(rid)!.push(`${p.title} → ${opt.title}`);
    }
  }
}

const GUILD_ID = '326474832151838730'; // @everyone shares the guild snowflake

// --- The survivors, named once so merge targets can't drift ------------------
const MEMBER = '1078755185423286372';
const SUPPORTER = '1051260775995551784'; // "Supporters" — kept as the one supporter role

// --- Explicit plan, one entry per human-assignable role ----------------------
// Anything not listed here is derived: bot-managed → untouchable, @everyone → keep.
const PLAN: Record<string, Plan> = {};
const set = (ids: string[], p: Plan) => ids.forEach((id) => (PLAN[id] = p));

// 1. Staff and permissions ----------------------------------------------------
set(['508654771276873729'], { verdict: 'keep', group: 'staff', why: 'The whole website staff list per TWO-44/IDENTIFIERS.md. Server owner, 1 holder.' });
set(['1078757544169848933'], { verdict: 'keep', group: 'staff', why: 'Ban/kick + 3 holders + 6 channel overwrites. Who moderates is a CEO call, out of scope here.' });
set(['1087192823767515219'], { verdict: 'keep', group: 'staff', why: 'Ban/kick + 6 holders, gates the 6 staff channels. Same reason as Officer.' });
set(['1078757266469175386'], { verdict: 'keep', group: 'staff', why: 'Ban/kick + 1 holder, gates LEADERSHIP. Same reason as Officer.' });
set(['1112759027554844763'], { verdict: 'keep', group: 'staff', why: 'Load-bearing: view+send on 8 ticket channels. The ticket system runs on it.' });
set(['1179233886178394142'], { verdict: 'keep', group: 'staff', why: 'TWO-14 Wave 0 adds its view overwrite on the shooter channel. Deleting it undoes that fix.' });
set(['1179233934303825920'], { verdict: 'keep', group: 'staff', why: 'Zero holders, but TWO-14 Wave 0 wires it alongside Game Staff: Shooter. Keep the pair symmetric.' });
set(['1078757184021733426', '1078756990710452365', '1078757334504976384'], {
  verdict: 'delete', group: 'staff',
  why: 'Zero holders. Captain/Lieutenant carry ban+kick; Legate is a hoisted empty rank. All three grant +view on LEADERSHIP, staff-applications and bot-commands — every one of those grants is duplicated by Officer, Game Master and SySOp, who do have holders. Repoint nothing, lose nothing.',
});
set(['448890318989819904', '465229022130077697'], {
  verdict: 'delete', group: 'staff',
  why: 'Mention Everyone, zero holders, zero overwrites. Two spare ways to ping the whole server.',
});

// 2. Rank ladder --------------------------------------------------------------
set(['1144789677057003636'], { verdict: 'keep', group: 'rank', why: 'Most-held real role in the server (51). Onboarding grants it.' });
set([MEMBER], { verdict: 'keep', group: 'rank', why: '41 holders and 36 channel overwrites. The single most load-bearing role after @everyone.' });
set(['1078755880343965777', '1078755949814231160', '1078756016071659605'], {
  verdict: 'keep', group: 'rank',
  why: 'The activity ladder, 30 people between them. What the tiers should mean is a CEO call (issue scope).',
});
set(['1052647673724944484', '1078755594950955189', '1078755666191188029'], {
  verdict: 'merge', group: 'rank', mergeInto: MEMBER,
  why: 'A second, parallel rank ladder (Initiate/Maven/Luminary) with 5 holders total, duplicating Prospect→Member→Soldier. Grant Member to any holder who lacks it, then delete.',
});
set(['448584234907729940'], {
  verdict: 'merge', group: 'rank', mergeInto: MEMBER,
  why: 'Legacy TWO.gg-era badge, 2 holders, not hoisted, no wiring. Grant Member if absent, then delete.',
});
set(['448587293154869250'], { verdict: 'keep', group: 'rank', why: 'Heritage badge, 5 holders, hoisted. Costs one sidebar group and buys goodwill. Un-hoisting is the cheap option if the sidebar needs shortening.' });

// 3. Lifecycle / gate markers -------------------------------------------------
set(['1104855809323696208'], { verdict: 'keep', group: 'lifecycle', why: 'DO NOT TOUCH. Deny-view overwrite on 55 channels. Deleting it opens 55 channels to its 4 holders.' });
set(['1391524788513673236'], { verdict: 'keep', group: 'lifecycle', why: 'Auto-role on all 30 members stuck at the rules screen. It is the identifier for TWO-53 rules-gate conversion.' });
set(['1113180728381931630'], { verdict: 'keep', group: 'lifecycle', why: '32 holders, no permissions, no wiring, unknown grantor. Too many people to delete on a guess in wave 1. Revisit once the bot audit (TWO-42) says what issues it.' });

// 4. Separators ---------------------------------------------------------------
const SEPARATORS = [
  '1101315895390900295', '1101312355608035398', '1101315995764805712',
  '1101314731089862778', '1101170473108242452', '1101297337919340585',
  '1101306065246752768', '1101297505179816017', '1101297643503767582',
  '1132805194707644529', '1132805520953184297', '1132805628172173322',
];
set(SEPARATORS, {
  verdict: 'delete', group: 'separator',
  why: 'Not hoisted, so they draw no line in the member sidebar — the only thing they were built to do. What they actually do is render as gibberish pills on up to 47 member profiles and pad the roles list. Zero permissions, zero overwrites.',
});

// 5. Platform ------------------------------------------------------------------
set(['1092247753574330458', '1087930995875008522', '1087931108945039470', '1092248449786855595', '1092250849717264475'], {
  verdict: 'keep', group: 'platform',
  why: 'Onboarding-granted, 65 holders across the five, and the only "what hardware do you own" signal we have for matchmaking members into voice.',
});

// 6. Location ------------------------------------------------------------------
set(['1087897546741006456', '1087897623538704475', '1087897738265509938', '1087897790681731122', '1087898062669750353'], {
  verdict: 'keep', group: 'location',
  why: 'Onboarding-granted, 34 holders. Timezone is what makes a voice room have anyone in it. TWO-14 already makes the prompt optional rather than removing it.',
});
set(['1087897935045476402'], { verdict: 'delete', group: 'location', why: 'Zero holders. Onboarding grants it, so the prompt option goes first.' });

// 7. Notification opt-ins -------------------------------------------------------
set(['1088982029523226728', '1088982099375181864', '1088981961789415546', '1090651387236450416'], {
  verdict: 'keep', group: 'notify',
  why: 'Live opt-in pings — 61 holders across the four. These are the only permissioned way to reach members without mass-DMing them.',
});
set(['1088982263292756059', '1088982372122374185'], {
  verdict: 'keep', group: 'notify',
  why: 'KEEP BOTH, and this is deliberate. DM\'s Closed looks redundant (closed is the default) but it is 10 members\' recorded opt-out of being messaged. Deleting it destroys a consent record, and the first re-engagement DM we ever send would then hit people who asked us not to.',
});

// 8. Game interest ---------------------------------------------------------------
set(['1051272877871222915', '1119666971584237679', '1179233034713702511'], {
  verdict: 'keep', group: 'game',
  why: 'The three games with a channel and 44 holders between them. TWO-14 Wave 0 finally wires the doors open.',
});
set([
  '1063245872328081439', '1063255307410739241', '1063255343884406864',
  '1065438198316138507', '1065438396069191700', '1065438504521322526',
  '1179233301295284385',
], { verdict: 'delete', group: 'game', why: 'Zero holders, no channel, not in onboarding. Dead game roles from 2023.' });

// 9. Interest roles orphaned by the onboarding prompt ------------------------------
set(['1055496084434206852', '1055499328195666022', '1063252753255776256', '1063252694543913020', '1063252816967249940'], {
  verdict: 'delete', group: 'interest',
  why: 'Zero holders. The "What interests you?" prompt grants a *channel*, not these roles — role_ids is empty on every one of its options, so these have been orphans since the prompt was written.',
});
set(['1055499317361782864'], {
  verdict: 'delete', group: 'interest',
  why: 'Zero holders. The one interest role the prompt does still grant, which is why the prompt option must be edited before it goes.',
});
set(['1055499052801855528', '1056439099701076008'], {
  verdict: 'delete', group: 'interest',
  why: 'One holder each, no channel, no prompt, no permissions. Export the two holders, then delete.',
});

// 10. Social/account roles ----------------------------------------------------------
set(['1087930764974358568', '1087930904866979931', '1087931739126628353', '1087931795347099748', '1087931842432356373', '1087931915933323329'], {
  verdict: 'delete', group: 'social',
  why: 'Zero holders, no channel, no prompt. "I have a Steam account" is not information a 84-member server can act on.',
});
set(['1063280360676409405'], {
  verdict: 'keep', group: 'social',
  why: '2 holders and it is the target for the go-live alerts on the roadmap. Keeping a role we are about to wire up.',
});

// 11. Supporter / monetisation ladder -------------------------------------------------
set([SUPPORTER], {
  verdict: 'keep', group: 'supporter',
  why: 'Kept as the single supporter role. Its view overwrite on 💎〢supporters already exists; add the same on 🎉〢subscriber-rewards before the tiers below are deleted.',
});
set([
  '1112811366944874536', '1112811276771528855', '1112810451785498654', '1112809780222906509',
  '1112809656885202974', '1112809538396098720', '1112809426349457459', '1112809331398815824',
  '1112809226427957379', '1112801161163055255',
], {
  verdict: 'delete', group: 'supporter',
  why: 'Ten hoisted paid tiers, zero holders in all ten. Each grants +view on 💎〢supporters and 🎉〢subscriber-rewards; the survivor covers both. A ten-tier pricing ladder for a product with no customers.',
});
set(['1051260096333750322', '1051260362873385000', '1051260579022643281'], {
  verdict: 'delete', group: 'supporter',
  why: 'Older three-tier version of the same ladder. Zero holders, one overwrite each, superseded by the survivor.',
});
set(['1140377116370804756'], {
  verdict: 'delete', group: 'supporter',
  why: 'Zero holders, hoisted, +view on 💎〢supporters. A monthly award that has never been given.',
});
set(['1090627565934366863'], { verdict: 'delete', group: 'supporter', why: 'Zero holders, no colour wiring, no overwrites. Name suggests it was a duplicate of a supporter tier.' });
set(['1078863839199772702'], { verdict: 'delete', group: 'supporter', why: 'Zero holders. A hoisted "currently live" role that nothing sets. Streamer covers the concept.' });

// 12. Event / campaign artifacts -----------------------------------------------------
set(['1078084405026889750'], { verdict: 'delete', group: 'event', why: 'Zero holders. Contest ended.' });
set(['1080508643558047754'], { verdict: 'delete', group: 'event', why: '5 holders, no wiring. An event badge from a finished event. Export the five, then delete.' });
set(['1149888357439127573'], { verdict: 'delete', group: 'event', why: '10 holders, no wiring. A 2023 giveaway cohort. Export the ten, then delete.' });
set(['1146631068787671110', '1146631222395670538', '1146631481461055558', '1254778753876496485'], {
  verdict: 'decision', group: 'event', recommended: 'delete',
  why: 'Battlepass tiers, 15 holders across three, fourth empty. Nothing has updated them since 2023. Delete unless the battlepass is coming back — that is a programme decision, not an engineering one.',
});

// 13. Junk --------------------------------------------------------------------------
set(['1065438630253953044', '1084500694423318558'], { verdict: 'delete', group: 'junk', why: 'Literally named "new role". Zero holders, zero everything.' });

// 14. NSFW / colour ------------------------------------------------------------------
set(['1094046641008418816'], { verdict: 'keep', group: 'access', why: '10 holders, +view on 🔞〢nsfw. It is the age-gate on the one age-gated channel.' });
set(['1060912046012633148'], {
  verdict: 'delete', group: 'colour',
  why: 'Zero holders. Its only job is +view on 🌈〢color-change. Goes with whichever way the colour decision lands; harmless either way because nobody holds it.',
});
set(['1092823497924956300'], {
  verdict: 'keep', group: 'colour',
  why: '6 holders and the only role that can see 🌈〢color-change. If the colour feature is fixed rather than removed, this is the door.',
});
const COLOURS = roles
  .filter((r) => !r.managed && r.color !== 0 && !PLAN[r.id] && r.id !== GUILD_ID && r.permissions === '0')
  .map((r) => r.id);
set(COLOURS, {
  verdict: 'decision', group: 'colour', recommended: 'keep',
  why: 'Color-Chan\'s palette. 51 roles, 6 holders between them, and the channel that drives it is unusable — @everyone is denied and the one role allowed to view it is denied send, so nobody can run the command. Recommend fixing the door (one overwrite) rather than 51 irreversible deletions; measure in 30 days. Deleting instead also means removing Color-Chan, or it recreates them.',
});

// --- Waves and exports -------------------------------------------------------
/** Does this row is retired under the recommended plan? */
const retires = (p: Plan) =>
  p.verdict === 'delete' || p.verdict === 'merge' || (p.verdict === 'decision' && p.recommended === 'delete');

/**
 * Why a holder list has to be written to audit/ before this role is deleted.
 * Separators are the deliberate exception: nobody wants their spacer pill back,
 * so exporting ~330 member-role pairs to restore twelve decorations is a privacy
 * cost with no rollback value.
 */
function exportReason(p: Plan, r: any, h: number): string {
  if (!retires(p) || h === 0) return 'no';
  if (p.group === 'separator') return 'no — decoration, nothing to restore';
  if (p.verdict === 'merge') return 'yes — to verify every holder got the survivor';
  return 'yes — rollback';
}

/**
 * Migration wave. Lowest risk first: nothing that touches a live holder or a
 * live permission happens before everything that touches neither.
 */
function wave(p: Plan, r: any, h: number, ows: number, onb: number): string {
  if (!retires(p)) return '';
  if (onb > 0 && p.group !== 'separator') return 'R3 — edit the onboarding option first';
  if (p.group === 'separator') return onb > 0 ? 'R4a — separator, onboarding-granted' : 'R4b — separator';
  if (p.verdict === 'merge') return 'R5 — regrant survivor, verify, then delete';
  if (h > 0) return 'R6 — export holders, announce, then delete';
  if (ows > 0) return 'R2 — confirm the overwrite is redundant, then delete';
  return 'R1 — dead weight, no holders, no wiring';
}

// --- Emit --------------------------------------------------------------------
const rows = roles
  .slice()
  .sort((a, b) => b.position - a.position || Number(b.id) - Number(a.id))
  .map((r) => {
    const ows = overwrites.get(r.id) ?? [];
    const onb = grantedBy.get(r.id) ?? [];
    let plan: Plan;
    if (r.managed) {
      plan = { verdict: 'untouchable', group: 'bot', why: 'Owned by a bot integration. Discord will not let us delete it; it goes when the bot goes (TWO-42).' };
    } else if (r.id === GUILD_ID) {
      plan = { verdict: 'keep', group: 'baseline', why: '@everyone.' };
    } else if (PLAN[r.id]) {
      plan = PLAN[r.id];
    } else {
      throw new Error(`unclassified role ${r.id} ${r.name}`);
    }
    const survivor = plan.mergeInto ? byId.get(plan.mergeInto) : undefined;
    return {
      role_id: r.id,
      name: r.name,
      group: plan.group,
      verdict: plan.verdict,
      recommended: plan.recommended ?? '',
      merge_into_id: plan.mergeInto ?? '',
      merge_into_name: survivor?.name ?? '',
      holders: holders(r.id),
      holders_move: plan.verdict === 'merge' ? holders(r.id) : 0,
      needs_holder_export: exportReason(plan, r, holders(r.id)),
      wave: wave(plan, r, holders(r.id), ows.length, onb.length),
      hoisted: r.hoist ? 'yes' : 'no',
      overwrite_count: ows.length,
      overwrite_channels: ows.slice(0, 6).join(' | '),
      granted_by_onboarding: onb.length ? 'yes' : 'no',
      onboarding_options: onb.join(' | '),
      permission_class: r.managed
        ? 'bot'
        : String(r.permissions) === '0'
          ? 'cosmetic'
          : 'has-permissions',
      why: plan.why,
    };
  });

const cols = Object.keys(rows[0]);
const esc = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(
  resolve(ROOT, 'audit/role-consolidation.csv'),
  [cols.join(','), ...rows.map((r) => cols.map((c) => esc((r as any)[c])).join(','))].join('\n') + '\n',
);

// --- Totals, printed so the document's numbers come from here ----------------
const human = rows.filter((r) => r.verdict !== 'untouchable' && r.role_id !== GUILD_ID);
const count = (v: Verdict) => human.filter((r) => r.verdict === v).length;
const decisionsIf = (rec: string) => human.filter((r) => r.verdict === 'decision' && r.recommended === rec).length;

console.log(`total roles                 ${rows.length}`);
console.log(`  bot-managed (untouchable) ${rows.filter((r) => r.verdict === 'untouchable').length}`);
console.log(`  @everyone                 1`);
console.log(`  human-assignable          ${human.length}`);
console.log(`    keep                    ${count('keep')}`);
console.log(`    merge                   ${count('merge')}`);
console.log(`    delete                  ${count('delete')}`);
console.log(`    decision                ${count('decision')}  (recommended keep ${decisionsIf('keep')}, delete ${decisionsIf('delete')})`);
console.log(`\nif every recommendation is taken:`);
const survives = count('keep') + decisionsIf('keep');
console.log(`  human-assignable roles    ${human.length} -> ${survives}`);
console.log(`  roles deleted             ${count('merge') + count('delete') + decisionsIf('delete')}`);
console.log(`  ...of which hold nobody   ${human.filter((r) => (r.verdict === 'merge' || r.verdict === 'delete' || (r.verdict === 'decision' && r.recommended === 'delete')) && r.holders === 0).length}`);
console.log(`  members needing a regrant ${human.filter((r) => r.verdict === 'merge').reduce((a, r) => a + r.holders, 0)} role-holdings`);
console.log(`  roles needing an export   ${human.filter((r) => r.needs_holder_export.startsWith('yes')).length}`);
console.log(`  hoisted sidebar groups    ${human.filter((r) => r.hoisted === 'yes' && r.holders > 0).length} render today -> ${human.filter((r) => r.hoisted === 'yes' && r.holders > 0 && (r.verdict === 'keep' || (r.verdict === 'decision' && r.recommended === 'keep'))).length} after`);
console.log(`\nwaves:`);
{
  const w = new Map<string, number>();
  for (const r of human) if (r.wave) w.set(r.wave, (w.get(r.wave) ?? 0) + 1);
  for (const [k, v] of [...w].sort()) console.log(`  ${k.padEnd(48)} ${v} roles`);
}
console.log(`\nif the colour block is deleted too:`);
console.log(`  human-assignable roles    ${human.length} -> ${survives - decisionsIf('keep')}`);
console.log(`\nonboarding options touching a retired role:`);
for (const r of human) {
  const dies = r.verdict === 'delete' || r.verdict === 'merge' || (r.verdict === 'decision' && r.recommended === 'delete');
  if (dies && r.granted_by_onboarding === 'yes') console.log(`  ${r.role_id} ${r.name}  <-  ${r.onboarding_options}`);
}
console.log(`\ndeletions that carry a channel overwrite:`);
for (const r of human) {
  const dies = r.verdict === 'delete' || r.verdict === 'merge' || (r.verdict === 'decision' && r.recommended === 'delete');
  if (dies && r.overwrite_count > 0) console.log(`  ${r.role_id} ${r.name} (${r.holders} holders) -> ${r.overwrite_count}: ${r.overwrite_channels}`);
}

/**
 * Answer one question about two captured snapshots: would a drift gate accept the second
 * one against the first, and if not, on which fields.
 *
 *   node scripts/live-cleanup-drift-diff.ts <a/pre.json> <b/pre.json>
 *
 * Why this exists rather than being a thing to reason about. The apply-time drift gate, the
 * postflight hash and both of rollback's hash gates all compare two *live* reads, and two of
 * them are reached with writes already applied — so a field that moves on its own does not
 * fail the phase safely, it fails it after the guild has changed. The stub suite cannot find
 * that class at all: `test/fixtures/live-cleanup-production-state.json` was captured without
 * `last_message_id`, and nothing in the fixture ever posts a message. The only thing that can
 * is two real captures of the live guild, compared field by field.
 *
 * That is how `last_message_id` was found (TOG-3141, round 16) and it is the check to run
 * before the next live apply: capture, wait the length of the window the apply plus its
 * rollback decision will really take, capture again, and run this. Exit 0 means a drift gate
 * would accept; exit 1 names the fields that moved. A non-empty `channel field drift` or
 * `guild field drift` list on a window where no operator touched anything is the same bug again
 * in a new field, and it belongs in `DRIFT_VOLATILE_CHANNEL_FIELDS` or
 * `DRIFT_VOLATILE_GUILD_FIELDS` — with the measurement, not on suspicion.
 *
 * WHEN A LIVE APPLY OR ROLLBACK REFUSES ON DRIFT, this is the tool, and the refusal is the
 * designed path rather than a defect. Both denylists fail closed: a field nobody has measured
 * yet is compared, so it refuses, and refusing is the safe direction. The loop is
 *
 *   1. run this against the run's own `snapshot/pre.json` and a capture taken now;
 *   2. read the per-field lines — `features (reordered only, set-equal)` is expected on almost
 *      every pair and is already forgiven by `normalizeGuild`'s sort;
 *   3. a field that moved with nobody acting on the guild goes in the matching denylist, with
 *      the pair that showed it written down;
 *   4. re-run the apply or rollback.
 *
 * What must never happen at step 3 is adding a field an administrator really changed. Every
 * field on a denylist is drift these gates permanently stop seeing, and two of the gates are
 * reached with writes already applied.
 *
 * Read-only: no network, no Discord token, no writes.
 */
import { readFileSync } from 'node:fs';
import { driftSemanticHash, withSemanticHash, type LiveCleanupSnapshot } from '../src/redesign/live-cleanup.ts';

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error('usage: node scripts/live-cleanup-drift-diff.ts <a/pre.json> <b/pre.json>');
  process.exit(2);
}

function load(path: string): { input: Omit<LiveCleanupSnapshot, 'semanticHash'>; stored: string } {
  const { semanticHash, ...input } = JSON.parse(readFileSync(path, 'utf8')) as LiveCleanupSnapshot;
  // A capture older than the last change to `semanticSnapshot` will not reproduce its own stored
  // hash here, and that is expected rather than corruption: the five captures from 2026-09-16
  // before 23:46Z verify against 4abcc0a~1 and fail against HEAD, and the two after it do the
  // reverse. Worth saying out loud, not worth refusing over — the drift verdict below re-derives
  // both sides from their bodies under this revision, so it stays symmetric either way.
  const recomputed = withSemanticHash(input).semanticHash;
  if (semanticHash !== recomputed) {
    console.log(`note: ${path} stores ${semanticHash} but rehashes to ${recomputed} — it was captured by a different revision of the snapshot code. The drift comparison below is unaffected.`);
  }
  return { input, stored: semanticHash };
}

const a = load(pathA);
const b = load(pathB);

const driftA = driftSemanticHash(a.input);
const driftB = driftSemanticHash(b.input);
console.log(`${pathA}\n  stored ${a.stored}\n  drift  ${driftA}`);
console.log(`${pathB}\n  stored ${b.stored}\n  drift  ${driftB}`);

const byId = (channels: LiveCleanupSnapshot['channels']) => new Map(channels.map((channel) => [channel.id, channel as unknown as Record<string, unknown>]));
const channelsA = byId(a.input.channels);
const channelsB = byId(b.input.channels);
const fieldCounts = new Map<string, string[]>();
for (const [id, channelA] of channelsA) {
  const channelB = channelsB.get(id);
  if (!channelB) continue;
  for (const field of new Set([...Object.keys(channelA), ...Object.keys(channelB)])) {
    if (JSON.stringify(channelA[field]) === JSON.stringify(channelB[field])) continue;
    fieldCounts.set(field, [...(fieldCounts.get(field) ?? []), id]);
  }
}
const onlyA = [...channelsA.keys()].filter((id) => !channelsB.has(id));
const onlyB = [...channelsB.keys()].filter((id) => !channelsA.has(id));

// Raw field comparison, deliberately ahead of any normalization: a field listed here that the
// hash then forgives (an auto-voice child appearing, `guild.features` reordering) is exactly the
// pairing worth seeing. The verdict line below is the hash's, not this list's.
console.log(`channels ${channelsA.size} -> ${channelsB.size}; only in A: ${onlyA.join(', ') || 'none'}; only in B: ${onlyB.join(', ') || 'none'}`);
for (const [field, ids] of [...fieldCounts].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`channel field drift: ${field} on ${ids.length} channel(s): ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}`);
}
for (const key of ['guild', 'roles', 'members', 'integrations', 'references'] as const) {
  if (JSON.stringify(a.input[key]) !== JSON.stringify(b.input[key])) console.log(`non-channel drift: ${key}`);
}

// The guild body gets the same field-by-field treatment the channels get above, because
// `non-channel drift: guild` on its own does not tell an operator whether a rollback refused on
// a boost count or on someone moving the rules channel — and those need opposite responses. It
// also names whether an array is merely reordered, which is the shape `normalizeGuild`'s sort
// forgives: expect `features` here on essentially every pair, set-equal, and expect the hash to
// accept anyway. A field named here that the verdict below still refuses is either real drift or
// the next `DRIFT_VOLATILE_GUILD_FIELDS` entry — decided by measurement, not on suspicion.
const guildA = a.input.guild as Record<string, unknown>;
const guildB = b.input.guild as Record<string, unknown>;
for (const field of [...new Set([...Object.keys(guildA), ...Object.keys(guildB)])].sort()) {
  if (JSON.stringify(guildA[field]) === JSON.stringify(guildB[field])) continue;
  const bothArrays = Array.isArray(guildA[field]) && Array.isArray(guildB[field]);
  const setEqual = bothArrays && JSON.stringify((guildA[field] as unknown[]).map(String).sort()) === JSON.stringify((guildB[field] as unknown[]).map(String).sort());
  console.log(`guild field drift: ${field}${setEqual ? ' (reordered only, set-equal)' : ''}`);
}

if (driftA === driftB) {
  console.log('DRIFT-EQUAL: a drift gate would accept the second capture against the first.');
  process.exit(0);
}
console.log('DRIFT: a drift gate would refuse. Every field named above is either real drift to investigate or a volatile field this phase has not yet accounted for.');
process.exit(1);

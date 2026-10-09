import type { TempVoiceStore } from '../src/tempVoice/store.ts';

export const PER_GUILD = 40; // mirrors maxPerGuild default: a full guild
export const SEED_BASE = Date.parse('2026-06-01T00:00:00.000Z');

type SeedStore = Pick<TempVoiceStore, 'reserveIfUnderCaps' | 'attach' | 'beginOwnerChange' | 'audit'>;

/** Seed only through the store, without importing a database or Discord client. */
export async function seedTempVoiceBenchmark(store: SeedStore, guilds: number) {
  // Most rows live, 5% in-flight reservations, one interrupted transition
  // per guild (2.5%), with both durable intent and a pending journal row.
  let channels = 0;
  let audits = 0;
  let reservations = 0;
  let interruptedTransitions = 0;
  const probe = { guild: '', channel: '' };
  for (let g = 0; g < guilds; g++) {
    const guild = `bench-guild-${g}`;
    for (let c = 0; c < PER_GUILD; c++) {
      const owner = `user-${g}-${c % 10}`;
      const at = new Date(SEED_BASE + (g * PER_GUILD + c) * 60_000).toISOString();
      const res = await store.reserveIfUnderCaps({
        guildId: guild,
        generatorId: `gen-${g}`,
        categoryId: `cat-${g}`,
        ownerId: owner,
        name: `room-${c}`,
        createdAt: at,
        maxPerUser: 1000,
        maxPerGuild: 1000,
        cooldownSeconds: 0,
      });
      if (!res.ok) throw new Error(`bench seed refused: ${res.reason} (guild ${g} channel ${c})`);
      audits++; // reserveIfUnderCaps persists a create_reservation/accepted audit.
      const channel = `chan-${g}-${c}`;
      if (c % 20 === 19) {
        // In-flight reservation: never attached, dropped by boot reconcile.
        await store.audit({ guildId: guild, actorId: owner, channelId: null, action: 'create', outcome: 'ok' }, at);
        audits++;
        reservations++;
        continue;
      }
      if (!await store.attach(res.row.id, channel)) throw new Error(`bench seed attach refused: ${channel}`);
      channels++;
      await store.audit({ guildId: guild, actorId: owner, channelId: channel, action: 'create', outcome: 'ok' }, at);
      audits++;
      if (c === PER_GUILD - 2) {
        // Interrupted transition: intent persisted, journal row written.
        if (!await store.beginOwnerChange(res.row.id, owner, `user-${g}-next`)) {
          throw new Error(`bench seed owner change refused: ${channel}`);
        }
        await store.audit(
          { guildId: guild, actorId: null, channelId: channel, action: 'owner_change', outcome: 'pending', reason: 'bench seed: interrupted grant' },
          at,
        );
        audits++;
        interruptedTransitions++;
      }
      if (g === 0 && c === 0) probe.guild = guild;
      if (g === 0 && c === 1) probe.channel = channel;
    }
  }
  return { channels, audits, reservations, interruptedTransitions, probe };
}

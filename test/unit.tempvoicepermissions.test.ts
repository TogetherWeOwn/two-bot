import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { DiscordTempVoiceGateway } from '../src/tempVoice/discord.ts';
import { TEMP_VOICE_REQUIRED_PERMISSIONS } from '../src/tempVoice/service.ts';

// Exercise the shipping adapter with local Discord objects; no login or REST.
for (const permission of TEMP_VOICE_REQUIRED_PERMISSIONS) {
  test(`category-effective ${permission} denial cannot be masked by guild grants`, async () => {
    const all = new PermissionsBitField(TEMP_VOICE_REQUIRED_PERMISSIONS.map((flag) => PermissionFlagsBits[flag]));
    const me = { permissions: all };
    const effective = new PermissionsBitField(all.bitfield).remove(PermissionFlagsBits[permission]);
    const client = {
      guilds: { fetch: async () => ({ members: { me } }) },
      channels: { fetch: async () => ({
        type: ChannelType.GuildCategory,
        permissionsFor: (member: unknown) => { assert.equal(member, me); return effective; },
      }) },
    } as unknown as Client;
    const gateway = new DiscordTempVoiceGateway(client);
    assert.deepEqual(await gateway.missingPermissions('guild', 'category', TEMP_VOICE_REQUIRED_PERMISSIONS), [permission]);
    effective.add(PermissionFlagsBits[permission]);
    assert.deepEqual(await gateway.missingPermissions('guild', 'category', TEMP_VOICE_REQUIRED_PERMISSIONS), []);
  });
}

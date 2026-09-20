/**
 * Deciding whether the temp-voice (join-to-create) generator is wired up on
 * a guild, with no network in sight - the thinking half for the
 * `--case=temp-voice` path in `scripts/staging-verify.ts`, mirroring
 * `evaluateHierarchy` in ./provision.ts.
 *
 * TOG-3471 is not merged as this lands, so there is nothing yet to import
 * from a real temp-voice config module. The env var names
 * (TWO_TEMP_VOICE_CATEGORY_ID / TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID) are
 * chosen to match src/tempVoice/config.ts on that branch, so this check
 * keeps validating correctly once that feature ships without needing a
 * source change here.
 */
import type { PartialChannel } from './provision.ts';

type TempVoiceChannel = PartialChannel & { parent_id?: string | null };

export const CHANNEL_TYPE_VOICE = 2;
export const CHANNEL_TYPE_CATEGORY = 4;

export interface TempVoiceStructureResult {
  ok: boolean;
  issues: string[];
}

/**
 * Checks that the configured generator channel exists, is a voice channel,
 * and sits under the configured category - the static shape create-on-join
 * depends on. Does not touch Discord; callers do the create/delete probe
 * themselves when they want proof the mutation actually works.
 */
export function evaluateTempVoiceStructure(
  channels: TempVoiceChannel[],
  opts: { categoryId: string; generatorChannelId: string },
): TempVoiceStructureResult {
  const issues: string[] = [];
  const byId = new Map(channels.map((c) => [c.id, c]));

  const category = byId.get(opts.categoryId);
  if (!category) {
    issues.push(`no channel with id ${opts.categoryId} (TWO_TEMP_VOICE_CATEGORY_ID) exists in this guild`);
  } else if (category.type !== CHANNEL_TYPE_CATEGORY) {
    issues.push(`channel ${opts.categoryId} (TWO_TEMP_VOICE_CATEGORY_ID) is not a category (type ${category.type})`);
  }

  const generator = byId.get(opts.generatorChannelId);
  if (!generator) {
    issues.push(`no channel with id ${opts.generatorChannelId} (TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID) exists in this guild`);
  } else {
    if (generator.type !== CHANNEL_TYPE_VOICE) {
      issues.push(
        `channel ${opts.generatorChannelId} (TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID) is not a voice channel (type ${generator.type})`,
      );
    }
    if (category && generator.parent_id !== opts.categoryId) {
      issues.push(
        `generator channel ${opts.generatorChannelId} is not parented under category ${opts.categoryId}`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

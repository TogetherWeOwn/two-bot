/**
 * Temp-voice generator structure, checked without Discord or a token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_TYPE_CATEGORY,
  CHANNEL_TYPE_VOICE,
  evaluateTempVoiceStructure,
} from '../src/staging/tempVoiceCheck.ts';

const CATEGORY = '111111111111111111';
const GENERATOR = '222222222222222222';

test('ok when the generator is a voice channel parented under the category', () => {
  const result = evaluateTempVoiceStructure(
    [
      { id: CATEGORY, name: 'Voice Rooms', type: CHANNEL_TYPE_CATEGORY },
      { id: GENERATOR, name: 'Join to Create', type: CHANNEL_TYPE_VOICE, parent_id: CATEGORY },
    ],
    { categoryId: CATEGORY, generatorChannelId: GENERATOR },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('fails when the category id does not exist', () => {
  const result = evaluateTempVoiceStructure(
    [{ id: GENERATOR, name: 'Join to Create', type: CHANNEL_TYPE_VOICE, parent_id: CATEGORY }],
    { categoryId: CATEGORY, generatorChannelId: GENERATOR },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes(CATEGORY)));
});

test('fails when the category id is not actually a category', () => {
  const result = evaluateTempVoiceStructure(
    [
      { id: CATEGORY, name: 'Not A Category', type: CHANNEL_TYPE_VOICE },
      { id: GENERATOR, name: 'Join to Create', type: CHANNEL_TYPE_VOICE, parent_id: CATEGORY },
    ],
    { categoryId: CATEGORY, generatorChannelId: GENERATOR },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('not a category')));
});

test('fails when the generator id does not exist', () => {
  const result = evaluateTempVoiceStructure(
    [{ id: CATEGORY, name: 'Voice Rooms', type: CHANNEL_TYPE_CATEGORY }],
    { categoryId: CATEGORY, generatorChannelId: GENERATOR },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes(GENERATOR)));
});

test('fails when the generator is not a voice channel', () => {
  const result = evaluateTempVoiceStructure(
    [
      { id: CATEGORY, name: 'Voice Rooms', type: CHANNEL_TYPE_CATEGORY },
      { id: GENERATOR, name: 'Join to Create', type: 0, parent_id: CATEGORY },
    ],
    { categoryId: CATEGORY, generatorChannelId: GENERATOR },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('not a voice channel')));
});

test('fails when the generator is not parented under the category', () => {
  const result = evaluateTempVoiceStructure(
    [
      { id: CATEGORY, name: 'Voice Rooms', type: CHANNEL_TYPE_CATEGORY },
      { id: GENERATOR, name: 'Join to Create', type: CHANNEL_TYPE_VOICE, parent_id: '999999999999999999' },
    ],
    { categoryId: CATEGORY, generatorChannelId: GENERATOR },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('not parented')));
});

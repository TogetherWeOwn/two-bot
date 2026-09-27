/**
 * TOG-5681: the funnel report prints ambiguous and unknown joins as separate
 * counts. These pin the split so a future merge of the two buckets fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributionCategory,
  summarizeAttributionSplit,
} from '../src/core/inviteTracker.ts';

test('ambiguous and unknown classify into different buckets', () => {
  assert.equal(attributionCategory('ambiguous:aaa+bbb'), 'ambiguous');
  assert.equal(attributionCategory('ambiguous'), 'ambiguous');
  assert.equal(attributionCategory('unknown'), 'unknown');
  assert.notEqual(
    attributionCategory('ambiguous:aaa+bbb'),
    attributionCategory('unknown'),
    'merging the two would hide which attribution problem to fix',
  );
});

test('invite and vanity sources are neither bucket', () => {
  assert.equal(attributionCategory('invite:aaa'), 'other');
  assert.equal(attributionCategory('vanity'), 'other');
  assert.equal(attributionCategory('web:one_click'), 'other');
});

test('summary keeps ambiguous and unknown counts separate', () => {
  const rows = [
    { source: 'invite:aaa', n: 5 },
    { source: 'ambiguous:aaa+bbb', n: 3 },
    { source: 'ambiguous:ccc+ddd', n: 2 },
    { source: 'unknown', n: 7 },
    { source: 'vanity', n: 1 },
  ];
  assert.deepEqual(summarizeAttributionSplit(rows), { ambiguous: 5, unknown: 7 });
});

test('summary is zero-zero on an empty window, not NaN', () => {
  assert.deepEqual(summarizeAttributionSplit([]), { ambiguous: 0, unknown: 0 });
});

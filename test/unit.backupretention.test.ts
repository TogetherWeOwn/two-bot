/**
 * Backup retention, pinned.
 *
 * The cases below are the ones a review found by running them: `""`,
 * `"fourteen"` and `"1_4"` each left 0 of 5 backups on disk, because
 * `Number()` turned them into `0` or `NaN` and `slice()` treats both as `0`.
 * The property that matters is simple enough to state and worth a test for
 * every setting anyone might plausibly type: a backup run must never end with
 * fewer backups than it started with because of how a variable was spelled.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKeep,
  toPrune,
  RetentionError,
  DEFAULT_KEEP,
} from '../src/store/backupRetention.ts';

describe('parseKeep', () => {
  test('unset means the default', () => {
    assert.equal(parseKeep(undefined), DEFAULT_KEEP);
  });

  test('empty or whitespace means the default, not zero', () => {
    // systemd cannot always distinguish an unset variable from an empty one,
    // and the safe reading of "I do not know" is "keep the usual number".
    for (const raw of ['', ' ', '\t', '\n']) {
      assert.equal(parseKeep(raw), DEFAULT_KEEP, `TWO_BACKUP_KEEP=${JSON.stringify(raw)}`);
    }
  });

  test('a positive whole number is taken at face value', () => {
    assert.equal(parseKeep('1'), 1);
    assert.equal(parseKeep('7'), 7);
    assert.equal(parseKeep(' 30 '), 30);
  });

  test('values that used to prune everything are now refused', () => {
    // Each of these previously reached slice() as 0 or NaN.
    for (const raw of ['fourteen', '1_4', '0', '-1', '1.5', '1e3', '0x0', 'null', 'NaN', '14 days']) {
      assert.throws(
        () => parseKeep(raw),
        RetentionError,
        `TWO_BACKUP_KEEP=${JSON.stringify(raw)} should be refused, not guessed at`,
      );
    }
  });
});

describe('toPrune', () => {
  const five = ['n1', 'n2', 'n3', 'n4', 'n5']; // newest first

  test('keeps the newest `keep` and returns the rest', () => {
    assert.deepEqual(toPrune(five, 2), ['n3', 'n4', 'n5']);
    assert.deepEqual(toPrune(five, 1), ['n2', 'n3', 'n4', 'n5']);
  });

  test('a keep larger than the list prunes nothing', () => {
    assert.deepEqual(toPrune(five, 14), []);
    assert.deepEqual(toPrune([], 14), []);
  });

  test('the newest backup is never pruned', () => {
    // The one just written is first in the list. Losing it is the specific
    // outcome that made this a data-loss bug rather than an untidy disk.
    for (let keep = 1; keep <= 10; keep++) {
      assert.ok(!toPrune(five, keep).includes('n1'), `keep=${keep} pruned the newest backup`);
    }
  });

  test('a keep that is not a positive integer is refused, not applied', () => {
    // Defence in depth: parseKeep is the gate, but if a future caller computes
    // `keep` some other way, the destructive step still refuses the values that
    // silently meant "delete everything".
    for (const keep of [0, -1, NaN, 1.5, Infinity]) {
      assert.throws(() => toPrune(five, keep), RetentionError, `keep=${String(keep)}`);
    }
  });
});

describe('retention window boundaries', () => {
  const five = ['n1', 'n2', 'n3', 'n4', 'n5']; // newest first

  test('an exact-fit window prunes nothing', () => {
    // keep == list length is the night the window fills: deleting anything
    // here would mean the window never actually holds what it promises.
    assert.deepEqual(toPrune(five, 5), []);
    assert.deepEqual(toPrune(['only'], 1), []);
  });

  test('one backup past the window prunes exactly the oldest', () => {
    // keep == length - 1 is the first night over the window. Only the oldest
    // goes; the newest four are untouched.
    assert.deepEqual(toPrune(five, 4), ['n5']);
  });

  test('one slot of headroom still prunes nothing', () => {
    assert.deepEqual(toPrune(five, 6), []);
  });

  test('a nightly window of DEFAULT_KEEP slides one backup per night', () => {
    const nights = (n: number) => Array.from({ length: n }, (_, i) => `night-${i + 1}`);
    assert.deepEqual(toPrune(nights(14), DEFAULT_KEEP), []);
    assert.deepEqual(toPrune(nights(15), DEFAULT_KEEP), ['night-15']);
    assert.deepEqual(toPrune(nights(20), DEFAULT_KEEP), [
      'night-15', 'night-16', 'night-17', 'night-18', 'night-19', 'night-20',
    ]);
  });

  test('survivors are always the newest min(keep, n), never fewer', () => {
    // The partition property: no keep value loses or reorders a backup, so a
    // run can never end with fewer backups than the window promises.
    for (let keep = 1; keep <= 7; keep++) {
      const pruned = toPrune(five, keep);
      const survivors = five.slice(0, five.length - pruned.length);
      assert.equal(survivors.length, Math.min(keep, five.length), `keep=${keep}`);
      assert.deepEqual([...survivors, ...pruned], five, `keep=${keep} lost or reordered a backup`);
    }
  });

  test('spelling the default explicitly keeps the default behaviour', () => {
    assert.equal(parseKeep(String(DEFAULT_KEEP)), DEFAULT_KEEP);
  });

  test('zero with width or padding is still zero and is refused', () => {
    // '00' passes a digit-only check and ' 0 ' survives trimming, so both
    // must reach the < 1 refusal rather than slice their way to an empty disk.
    for (const raw of ['00', ' 0 ', '000']) {
      assert.throws(
        () => parseKeep(raw),
        RetentionError,
        `TWO_BACKUP_KEEP=${JSON.stringify(raw)} should be refused, not guessed at`,
      );
    }
  });
});

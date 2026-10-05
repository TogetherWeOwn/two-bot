/**
 * Test-only wall-clock pin for child processes (TOG-10212 P2 regression).
 *
 * Loaded via `node --import`: replaces the global Date so a no-arg
 * `new Date()` / `Date.now()` returns the instant in TWO_TEST_CLOCK_FILE
 * (epoch milliseconds), while explicit date construction and parsing are
 * untouched. The loopback stub rewrites the file mid-run, so the capture
 * child stamps its window start at START even though the test process runs in
 * real time, then observes the clock advanced to FETCH when the roster is
 * actually read. That is the mid-window removal/rejoin race, deterministically.
 */
import { readFileSync } from 'node:fs';

const NativeDate = Date;
const clockFile = process.env.TWO_TEST_CLOCK_FILE;

function pinnedNow() {
  return Number(readFileSync(clockFile, 'utf8'));
}

globalThis.Date = class extends NativeDate {
  constructor(...args) {
    if (args.length === 0) super(pinnedNow());
    else super(...args);
  }
  static now() {
    return pinnedNow();
  }
};

/**
 * NO_COLOR + non-TTY-safe CLI output (TOG-8698).
 *
 * The analytics text renderers are printed to a terminal AND piped into
 * files, `cat`, and CI logs. Any styling must pass through
 * src/analytics/cliColor.ts, which honors NO_COLOR and detects pipes; a
 * renderer that paints unconditionally leaks ANSI escapes into every pipe.
 *
 * Fully offline: fixture strings and synthetic probes only, no database, no
 * network, no PTY.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorEnabled,
  hasAnsi,
  paint,
  stripAnsi,
  type ColorProbe,
} from '../src/analytics/cliColor.ts';

describe('colorEnabled precedence', () => {
  test('NO_COLOR disables even when forced or on a TTY', () => {
    assert.equal(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true }), false);
    // Presence is the whole signal: even NO_COLOR=0 disables.
    assert.equal(colorEnabled({ env: { NO_COLOR: '0' }, isTTY: true }), false);
    assert.equal(colorEnabled({ env: { NO_COLOR: '' }, isTTY: true }), true, 'empty NO_COLOR reads as unset');
  });

  test('a pipe is plain unless FORCE_COLOR overrides', () => {
    assert.equal(colorEnabled({ env: {}, isTTY: false }), false);
    assert.equal(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false }), true);
    assert.equal(colorEnabled({ env: { FORCE_COLOR: '0' }, isTTY: true }), true, 'FORCE_COLOR=0 reads as unset');
    assert.equal(colorEnabled({ env: { FORCE_COLOR: 'false' }, isTTY: true }), true, 'FORCE_COLOR=false reads as unset');
  });

  test('dumb terminals stay plain; TTYs get styling', () => {
    assert.equal(colorEnabled({ env: { TERM: 'dumb' }, isTTY: true }), false);
    assert.equal(colorEnabled({ env: {}, isTTY: true }), true);
    assert.equal(colorEnabled({ env: { TERM: 'xterm-256color' }, isTTY: true }), true);
  });
});

describe('paint / stripAnsi round-trip', () => {
  test('paint is identity when color is off', () => {
    const probe = { env: { NO_COLOR: '1' }, isTTY: true };
    assert.equal(paint('FAIL', 'red', probe), 'FAIL');
    assert.equal(paint('ok', ['bold', 'green'], probe), 'ok');
    assert.ok(!hasAnsi(paint('FAIL', 'red', probe)));
  });

  test('paint styles when color is on, and strip restores the plain text', () => {
    const probe = { env: { FORCE_COLOR: '1' }, isTTY: false };
    const styled = paint('FAIL', 'red', probe);
    assert.ok(hasAnsi(styled), 'styled text should carry an escape');
    assert.equal(stripAnsi(styled), 'FAIL');
    const multi = paint('ok', ['bold', 'green'], probe);
    assert.ok(hasAnsi(multi));
    assert.equal(stripAnsi(multi), 'ok');
  });

  test('padding outside paint keeps stripped output aligned', () => {
    const probe = { env: { FORCE_COLOR: '1' }, isTTY: false };
    const a = `  ${paint('FAIL', 'red', probe)}   title-a`;
    const b = `  ${paint('ok', 'green', probe)}     title-b`;
    assert.equal(stripAnsi(a), '  FAIL   title-a');
    assert.equal(stripAnsi(b), '  ok     title-b');
    assert.equal(stripAnsi(a).length - 'title-a'.length, stripAnsi(b).length - 'title-b'.length);
  });
});

describe('analytics render path carries no escapes under NO_COLOR or a pipe', () => {
  test('gated status tokens are plain when color is off', async () => {
    // Fixture-shaped stand-ins for the eval / gate-check verdict lines: the
    // invariant under test is that every styled token goes through paint,
    // whose off-state is the identity function.
    const probe = { env: { NO_COLOR: '1' }, isTTY: true };
    const lines = [
      `${paint('ok', 'green', probe)}   case-a (ambiguous)`,
      `${paint('FAIL', 'red', probe)} case-b (unknown)  -  detail here`,
      `  ${paint('UNKNOWN', 'yellow', probe)}  welcome criterion`,
    ];
    for (const line of lines) {
      assert.ok(!hasAnsi(line), `plain line leaked an escape:\n${JSON.stringify(line)}`);
    }
    assert.ok(lines[0]!.startsWith('ok   case-a'));
    assert.ok(lines[1]!.startsWith('FAIL case-b'));
  });

  test('the plain path is byte-stable: strip(styled) === plain', () => {
    const off = { env: { NO_COLOR: '1' }, isTTY: true };
    const on = { env: { FORCE_COLOR: '1' }, isTTY: false };
    const render = (probe: ColorProbe): string =>
      [
        `${paint('ok', 'green', probe)}   case-a (ambiguous)`,
        `${paint('FAIL', 'red', probe)} case-b (unknown)  -  detail here`,
      ].join('\n');
    assert.equal(stripAnsi(render(on)), render(off));
  });
});

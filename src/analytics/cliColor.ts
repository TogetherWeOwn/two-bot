/**
 * NO_COLOR-aware styling for human-readable CLI output (TOG-8698).
 *
 * The funnel / dashboard / roster / scorecard / eval scripts print text a
 * human reads on a terminal AND pipes into files, `cat`, and CI logs. Raw
 * ANSI escapes would leak into every pipe, and per-script `--color` flags
 * would drift apart, so there is exactly one gate: this module.
 *
 * Precedence (first match wins):
 *   1. `NO_COLOR` set to any non-empty value -> plain. Presence is the whole
 *      signal (https://no-color.org); even `NO_COLOR=0` disables.
 *   2. `FORCE_COLOR` set to a non-empty value other than `0`/`false` -> styled.
 *   3. `TERM=dumb` -> plain (a dumb terminal cannot use cursor styling either).
 *   4. Otherwise styled only when stdout is a TTY. Piped or redirected output
 *      (CI logs, `| cat`, `> file`) is always plain.
 *
 * Pure functions of an injected `(env, isTTY)` probe: unit tests pass both
 * explicitly, so no test needs a PTY, a database, or the network. Scripts
 * call the zero-arg forms, which read `process.env` and `process.stdout`.
 */
export interface ColorProbe {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

export function colorEnabled(probe: ColorProbe = {}): boolean {
  const env = probe.env ?? process.env;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  const force = (env.FORCE_COLOR ?? '').trim().toLowerCase();
  if (force !== '' && force !== '0' && force !== 'false') return true;
  if ((env.TERM ?? '').trim().toLowerCase() === 'dumb') return false;
  return probe.isTTY ?? process.stdout?.isTTY ?? false;
}

export type AnsiStyle = 'bold' | 'red' | 'green' | 'yellow' | 'dim';

const OPEN: Record<AnsiStyle, string> = {
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  dim: '\u001b[2m',
};
const CLOSE = '\u001b[0m';

/**
 * Wrap `text` in ANSI styling when the probe says color is on; otherwise
 * return `text` unchanged. Zero-arg callers get the process default
 * (`process.env` + `process.stdout.isTTY`), which is what `NO_COLOR=1 cmd`
 * and `cmd | cat` exercise.
 */
export function paint(text: string, style: AnsiStyle | AnsiStyle[], probe: ColorProbe = {}): string {
  if (!colorEnabled(probe)) return text;
  const styles = Array.isArray(style) ? style : [style];
  return `${styles.map((s) => OPEN[s]).join('')}${text}${CLOSE}`;
}

/** True when the string carries any ANSI SGR escape. */
export function hasAnsi(s: string): boolean {
  return /\u001b\[[0-9;]*m/.test(s);
}

/** Remove ANSI SGR escapes. `stripAnsi(colored) === plain` is the piping-safety invariant. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

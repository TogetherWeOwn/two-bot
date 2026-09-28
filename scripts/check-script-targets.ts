/**
 * Every `node scripts/<file>` target in package.json must exist on disk.
 *
 * WHY THIS EXISTS (TOG-6810). `package.json` mapped `reconcile` to
 * `node scripts/reconcile.ts` since the initial import (ebd5ccda, TOG-3531)
 * and no such file ever existed on any branch (`git log --all --full-history
 * -- "*reconcile*"` is empty). Nothing referenced it - no caller, doc, or
 * workflow - so the fix was removal, not invention. This guard stops the next
 * dangling entry at CI time instead of at `npm run <typo>` time.
 *
 * WHAT IT CHECKS: every `scripts` value containing `node scripts/<path>` must
 * point at a file that exists relative to the repo root. `bash scripts/...`
 * lines, `node src/...`, and `node --test ...` are out of scope and ignored.
 *
 *   node scripts/check-script-targets.ts
 *   node scripts/check-script-targets.ts --root /tmp/fixture-tree
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

// `node` + any `--flags` (including `--opt=value`), then the first
// `scripts/...` path. Global so `cmd1 && node scripts/b.ts` yields both.
const TARGET_RE = /\bnode\s+(?:--\S+(?:=\S+)?\s+)*?(scripts\/[^\s"'`]+)/g;

/** All `scripts/...` targets a single package.json script value invokes. */
export function extractTargets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(TARGET_RE)) {
    // A trailing `;`, `&`, `|`, `)`, `,` or `>` is shell syntax, not path.
    out.push(m[1].replace(/[),;>&|]+$/, ''));
  }
  return out;
}

export interface MissingTarget {
  script: string;
  target: string;
}

/** Every `node scripts/<x>` target under `root` that has no file on disk. */
export function findMissing(
  root: string,
  scripts: Record<string, string>,
): MissingTarget[] {
  const missing: MissingTarget[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const target of extractTargets(command)) {
      if (!existsSync(join(root, target))) missing.push({ script: name, target });
    }
  }
  return missing;
}

function readScripts(root: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let root = ROOT;
  const at = process.argv.indexOf('--root');
  if (at >= 0) {
    const dir = process.argv[at + 1];
    if (!dir) {
      console.error('check-script-targets: --root needs a directory');
      process.exit(2);
    }
    root = resolve(dir);
  }

  const missing = findMissing(root, readScripts(root));
  if (missing.length > 0) {
    for (const { script, target } of missing) {
      const msg = `package.json script "${script}" points at ${target}, which does not exist`;
      if (process.env.GITHUB_ACTIONS) console.log(`::error file=package.json,title=Missing script target::${msg}`);
      console.error(`check-script-targets: ${msg}`);
    }
    console.error(`check-script-targets: FAIL (${missing.length} dangling target(s))`);
    process.exit(1);
  }
  console.log('check-script-targets: every node scripts/<x> target in package.json exists');
}

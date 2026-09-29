/**
 * Every `node scripts/<file>` target in package.json must exist on disk,
 * and every script reference in docs/RUNBOOK.md and docs/DEPLOY.md must
 * resolve.
 *
 * WHY THIS EXISTS (TOG-6810). `package.json` mapped `reconcile` to
 * `node scripts/reconcile.ts` since the initial import (ebd5ccda, TOG-3531)
 * and no such file ever existed on any branch (`git log --all --full-history
 * -- "*reconcile*"` is empty). Nothing referenced it - no caller, doc, or
 * workflow - so the fix was removal, not invention. This guard stops the next
 * dangling entry at CI time instead of at `npm run <typo>` time.
 *
 * WHY THE DOCS HALF EXISTS (TOG-10007). The other direction drifted next:
 * docs/RUNBOOK.md described the 2026-08-25 drill as "migrated with
 * scripts/migrate-sqlite-to-postgres.ts" after TOG-450 (#101) removed that
 * file. An operator following the doc would run a script that does not
 * exist. So the docs half checks both reference kinds the two docs use:
 * direct `scripts/<path>` mentions must exist on disk, and `npm run <name>`
 * mentions must name a package.json script. Direct invocations
 * (`bash scripts/bootstrap-host.sh`, the `.mjs` deploy helpers) deliberately
 * have no npm entry, so "no npm entry" is never a failure - only a path
 * with no file, or a name with no script entry, fails.
 *
 * WHAT IT CHECKS: every `scripts` value containing `node scripts/<path>` must
 * point at a file that exists relative to the repo root. `bash scripts/...`
 * lines, `node src/...`, and `node --test ...` are out of scope and ignored.
 * Plus: every `scripts/<path>` in docs/RUNBOOK.md and docs/DEPLOY.md must
 * exist on disk, and every `npm run <name>` there must exist in package.json.
 *
 *   node scripts/check-script-targets.ts
 *   node scripts/check-script-targets.ts --root /tmp/fixture-tree
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

const DOCS = ['docs/RUNBOOK.md', 'docs/DEPLOY.md'];

// `node` + any `--flags` (including `--opt=value`), then the first
// `scripts/...` path. Global so `cmd1 && node scripts/b.ts` yields both.
const TARGET_RE = /\bnode\s+(?:--\S+(?:=\S+)?\s+)*?(scripts\/[^\s"'`]+)/g;

// `scripts/<path>` in prose. No `:` so `scripts/foo.ts:34` (file:line)
// yields just the path; backticks, quotes and parens delimit.
const DOC_TARGET_RE = /\bscripts\/[\w@./-]+/g;

// `npm run <name>` in prose.
const DOC_NPM_RUN_RE = /\bnpm run ([A-Za-z0-9:_.-]+)/g;

/** All `scripts/...` targets a single package.json script value invokes. */
export function extractTargets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(TARGET_RE)) {
    // A trailing `;`, `&`, `|`, `)`, `,` or `>` is shell syntax, not path.
    out.push(m[1].replace(/[),;>&|]+$/, ''));
  }
  return out;
}

/** Every distinct `scripts/<path>` mentioned in a markdown document. */
export function extractDocTargets(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(DOC_TARGET_RE)) {
    // A trailing `.` is sentence punctuation, not part of the path.
    out.add(m[0].replace(/[.]+$/, ''));
  }
  return [...out];
}

/** Every distinct `npm run <name>` named in a markdown document. */
export function extractDocNpmRuns(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(DOC_NPM_RUN_RE)) {
    // A trailing `.` is sentence punctuation, not part of the name.
    out.add(m[1].replace(/[.]+$/, ''));
  }
  return [...out];
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

export interface MissingDocRef {
  doc: string;
  ref: string;
  /**
   * `file`: a `scripts/<path>` with nothing on disk.
   * `npm-script`: an `npm run <name>` with no package.json entry.
   */
  kind: 'file' | 'npm-script';
}

/** Every docs script reference under `root` that resolves to nothing. */
export function findMissingDocRefs(
  root: string,
  docs: Record<string, string>,
  scripts: Record<string, string>,
): MissingDocRef[] {
  const missing: MissingDocRef[] = [];
  for (const [doc, markdown] of Object.entries(docs)) {
    for (const target of extractDocTargets(markdown)) {
      if (!existsSync(join(root, target))) missing.push({ doc, ref: target, kind: 'file' });
    }
    for (const name of extractDocNpmRuns(markdown)) {
      if (!(name in scripts)) missing.push({ doc, ref: name, kind: 'npm-script' });
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

function readDocs(root: string): Record<string, string> {
  const docs: Record<string, string> = {};
  for (const doc of DOCS) {
    try {
      docs[doc] = readFileSync(join(root, doc), 'utf8');
    } catch {
      console.error(`check-script-targets: ${doc} is missing`);
      process.exit(1);
    }
  }
  return docs;
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

  const scripts = readScripts(root);
  const missing = findMissing(root, scripts);
  if (missing.length > 0) {
    for (const { script, target } of missing) {
      const msg = `package.json script "${script}" points at ${target}, which does not exist`;
      if (process.env.GITHUB_ACTIONS) console.log(`::error file=package.json,title=Missing script target::${msg}`);
      console.error(`check-script-targets: ${msg}`);
    }
  }

  const missingDocs = findMissingDocRefs(root, readDocs(root), scripts);
  if (missingDocs.length > 0) {
    for (const { doc, ref, kind } of missingDocs) {
      const msg =
        kind === 'file'
          ? `${doc} references ${ref}, which does not exist`
          : `${doc} references "npm run ${ref}", which names no package.json script`;
      if (process.env.GITHUB_ACTIONS) console.log(`::error file=${doc},title=Dangling docs script reference::${msg}`);
      console.error(`check-script-targets: ${msg}`);
    }
  }

  const total = missing.length + missingDocs.length;
  if (total > 0) {
    console.error(`check-script-targets: FAIL (${total} dangling reference(s))`);
    process.exit(1);
  }
  console.log(
    'check-script-targets: every node scripts/<x> target in package.json exists, and every RUNBOOK.md/DEPLOY.md script reference resolves',
  );
}

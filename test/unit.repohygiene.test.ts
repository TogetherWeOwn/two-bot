// TOG-3162. `node_modules` was a TRACKED SYMLINK on main for six months (blob
// 8bf33bf, introduced by 0325380), and its committed target was one agent
// sandbox's absolute path. Every fresh clone therefore got a `node_modules` that
// pointed somewhere that did not exist on that machine, so `./node_modules/.bin/tsc`
// and `node --test` had no toolchain until somebody repointed the link by hand.
//
// It survived that long because `.gitignore` said `node_modules/` — with the
// trailing slash, which matches only a *directory*. A symlink named node_modules
// is not a directory, so the rule never looked at it and `git status` stayed clean
// while the link sat in the index.
//
// These cases are the regression fence. The second one is the one that matters:
// it does not read the pattern's spelling, it builds an actual symlink named
// node_modules and asks git whether it is ignored. Restoring the trailing slash
// fails it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// The image built by Dockerfile has no .git (`.dockerignore` drops it) and no
// test/ either, so this can only ever be skipped by a non-git consumer. It is
// never skipped in CI, where actions/checkout leaves a full work tree.
function isGitWorkTree(): boolean {
  try {
    return git('rev-parse', '--is-inside-work-tree') === 'true';
  } catch {
    return false;
  }
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
}

test('no path named node_modules is tracked', { skip: !isGitWorkTree() }, () => {
  // Matches the directory itself and anything under it, at any depth.
  const tracked = git('ls-files', '--', '*node_modules*', 'node_modules')
    .split('\n')
    .filter((line) => line.length > 0);
  assert.deepEqual(
    tracked,
    [],
    `node_modules must never be committed (as a directory OR a symlink). Tracked: ${tracked.join(', ')}`,
  );
});

test('a symlink named node_modules is ignored', { skip: !isGitWorkTree() }, () => {
  // `git check-ignore` is pathname matching, so the probe has to be a real
  // symlink on disk for git to classify it as a non-directory. Built in a temp
  // directory inside the repo because the ignore rules under test live at the
  // repo root; `node_modules` has no leading slash, so it matches at any depth.
  const probeDir = mkdtempSync(`${REPO}.repo-hygiene-probe-`);
  try {
    const probe = `${probeDir}/node_modules`;
    symlinkSync('/nonexistent/some/agent/sandbox/node_modules', probe);
    const rel = relative(REPO, probe);
    let ignored = true;
    try {
      // Exit 0 = ignored, exit 1 = not ignored, so the failure is an exception.
      git('check-ignore', '--quiet', '--', rel);
    } catch {
      ignored = false;
    }
    assert.equal(
      ignored,
      true,
      'a symlink named node_modules is not ignored. .gitignore probably says ' +
        '`node_modules/` again — the trailing slash restricts the rule to directories.',
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test('no tracked symlink points at an absolute path', { skip: !isGitWorkTree() }, () => {
  // The general shape of the bug: an absolute target is machine-specific by
  // construction, so it is wrong in every checkout but the one that made it.
  // A relative symlink inside the repo is fine and this does not forbid one.
  const absolute = git('ls-files', '-s')
    .split('\n')
    .filter((line) => line.startsWith('120000 '))
    .map((line) => line.split('\t').slice(1).join('\t'))
    .filter((path) => git('cat-file', '-p', `:${path}`).startsWith('/'));
  assert.deepEqual(
    absolute,
    [],
    `tracked symlinks with absolute targets: ${absolute.join(', ')}`,
  );
});

/**
 * scripts/bootstrap-host.sh's half of the off-box backup contract (TOG-892).
 *
 * Two things used to live only in prose, and both fail silently on a host nobody
 * is watching at 04:17:
 *
 *   1. deploy/two-backup-upload was installed by a `sudo install -m 755 ...` line
 *      a person copied out of docs/RUNBOOK.md. Miss it and the timer is enabled,
 *      backup.env is filled in, and every upload dies on ENOENT.
 *   2. TWO_BACKUP_UPLOAD_CMD being absent from backup.env is not an error
 *      anywhere - scripts/pg-backup.ts warns and exits 0 - so the unit goes green
 *      forever while every dump stays on the disk it is supposed to survive.
 *
 * These tests execute the script's real behaviour rather than describing it: the
 * guard's own regex is read out of the file and run, so restating the pattern
 * here cannot make the test agree with a script that has changed underneath it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOOTSTRAP = join(import.meta.dirname, '..', 'scripts', 'bootstrap-host.sh');
const script = readFileSync(BOOTSTRAP, 'utf8');

describe('bootstrap installs the upload wrapper', () => {
  test('the wrapper is installed executable, from the checkout, by the script', () => {
    // Anchored to a real `install` command, not to a mention of the path: a
    // comment or a runbook quote naming /usr/local/bin/two-backup-upload must
    // not be able to satisfy this.
    const line = script
      .split('\n')
      .find((l) => /^install -m 755 /.test(l));
    assert.ok(line, 'no `install -m 755` line installs the wrapper');
    assert.match(line!, /deploy\/two-backup-upload/);
    assert.match(line!, /\$UPLOAD_CMD/, 'the destination must be the UPLOAD_CMD variable');
  });

  test('the installed path is the one the operator is told to put in backup.env', () => {
    // The default of UPLOAD_CMD and the path named in the warning text have to
    // be the same string, or bootstrap installs to one place and tells you to
    // point TWO_BACKUP_UPLOAD_CMD at another.
    const def = script.match(/^UPLOAD_CMD="\$\{TWO_UPLOAD_CMD:-([^}]+)\}"/m);
    assert.ok(def, 'UPLOAD_CMD has no default');
    assert.equal(def![1], '/usr/local/bin/two-backup-upload');
    assert.match(script, /TWO_BACKUP_UPLOAD_CMD=\$UPLOAD_CMD/);
  });

  test('installing the wrapper actually produces a working uploader entrypoint', () => {
    // The install line's effect, executed: mode 755 and runnable. This is what
    // makes the difference between the timer working and ENOENT at 04:17.
    const dir = mkdtempSync(join(tmpdir(), 'two-bootstrap-'));
    try {
      const dest = join(dir, 'two-backup-upload');
      execFileSync('install', [
        '-m',
        '755',
        join(import.meta.dirname, '..', 'deploy', 'two-backup-upload'),
        dest,
      ]);
      assert.equal(statSync(dest).mode & 0o777, 0o755);

      // And it still honours its one-argument contract once installed.
      assert.throws(
        () => execFileSync(dest, [], { stdio: 'pipe' }),
        /status 2|Command failed/,
        'the installed wrapper should refuse a call with no dump path',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bootstrap warns when nightly dumps would stay on the box', () => {
  /**
   * Runs the guard's own grep - lifted verbatim out of bootstrap-host.sh - over
   * a backup.env fixture, and reports whether it considered the upload
   * configured. Extracting the pattern is the point: a copy of the regex in this
   * file would keep passing after someone weakened the one in the script.
   */
  const guard = script.match(/grep -Eq '([^']+)' \\\n\s+"\$ENV_DIR\/backup\.env"/);

  function configured(contents: string): boolean {
    assert.ok(guard, 'could not find the TWO_BACKUP_UPLOAD_CMD guard in bootstrap-host.sh');
    const dir = mkdtempSync(join(tmpdir(), 'two-envfix-'));
    try {
      const f = join(dir, 'backup.env');
      writeFileSync(f, contents);
      const r = execFileSync('/bin/sh', ['-c', `grep -Eq '${guard![1]}' "$1"; echo $?`, 'sh', f], {
        encoding: 'utf8',
      });
      return r.trim() === '0';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a filled-in upload command counts as configured', () => {
    assert.equal(configured('TWO_BACKUP_UPLOAD_CMD=/usr/local/bin/two-backup-upload\n'), true);
    assert.equal(configured('export TWO_BACKUP_UPLOAD_CMD=/usr/local/bin/two-backup-upload\n'), true);
    assert.equal(configured('  TWO_BACKUP_UPLOAD_CMD = /usr/local/bin/two-backup-upload\n'), true);
  });

  test('the cases that silently disable off-box backup are NOT counted as configured', () => {
    // Each of these leaves pg-backup.ts on its warn-and-exit-0 path.
    assert.equal(configured('TWO_DATABASE_URL=postgres://x\n'), false, 'absent');
    assert.equal(configured('TWO_BACKUP_UPLOAD_CMD=\n'), false, 'set to empty');
    assert.equal(configured('TWO_BACKUP_UPLOAD_CMD=   \n'), false, 'set to whitespace');
    assert.equal(
      configured('#TWO_BACKUP_UPLOAD_CMD=/usr/local/bin/two-backup-upload\n'),
      false,
      'commented out',
    );
    assert.equal(
      configured('# see TWO_BACKUP_UPLOAD_CMD=... in docs/RUNBOOK.md\n'),
      false,
      'merely mentioned in a comment',
    );
  });

  test('the warning names the variable and does not abort the deploy', () => {
    // Not fatal on purpose: local-only backups beat no backups, and this script
    // also brings up hosts before a destination exists. But it must be loud, and
    // it must go to stderr where a deploy log keeps it.
    const start = script.indexOf('WARNING: TWO_BACKUP_UPLOAD_CMD');
    assert.ok(start > 0, 'no warning text for an unconfigured upload command');
    assert.match(script, /cat >&2 <<EOF\n\n  WARNING: TWO_BACKUP_UPLOAD_CMD is not set/);

    // Scan the whole else-branch through its closing `fi`, not just the heredoc:
    // an `exit` placed after EOF and before fi still aborts the deploy, and an
    // earlier version of this test missed exactly that.
    const branch = script.slice(start, script.indexOf('\nfi\n', start));
    assert.ok(branch.includes('EOF'), 'expected the heredoc to close inside the branch');
    assert.doesNotMatch(
      branch,
      /^\s*(exit|fail)\b/m,
      'the missing-upload warning must not exit - a box with local backups still deploys',
    );
  });
});

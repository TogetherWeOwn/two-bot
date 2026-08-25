/**
 * The TWO_BACKUP_UPLOAD_CMD argv contract, and the wrapper that exists because
 * of it.
 *
 * This is here because docs/RUNBOOK.md once documented
 * `rclone copy --config X --to backup:two-funnel`, which cannot work: the dump
 * path is appended last, so rclone would have read the dump as its destination
 * (and `--to` is not an rclone flag at all). Prose could not catch that. These
 * tests can, and the last one actually runs deploy/two-backup-upload's shape
 * end to end.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUploadArgv } from '../src/store/uploadCmd.ts';

const DUMP = '/var/backups/two-bot/two-funnel-20260824T041700Z.ndjson.gz';

describe('buildUploadArgv', () => {
  test('unset or blank means no off-box copy, not an error', () => {
    assert.equal(buildUploadArgv(undefined, DUMP), null);
    assert.equal(buildUploadArgv('', DUMP), null);
    assert.equal(buildUploadArgv('   \t ', DUMP), null);
  });

  test('the dump path is the last argument', () => {
    const got = buildUploadArgv('/bin/cp -t /srv/backup-staging', DUMP);
    assert.deepEqual(got, { cmd: '/bin/cp', args: ['-t', '/srv/backup-staging', DUMP] });
    assert.equal(got!.args.at(-1), DUMP);
  });

  test('a bare wrapper receives exactly one argument', () => {
    const got = buildUploadArgv('/usr/local/bin/two-backup-upload', DUMP);
    assert.deepEqual(got, { cmd: '/usr/local/bin/two-backup-upload', args: [DUMP] });
  });

  test('surrounding and repeated whitespace does not produce empty argv slots', () => {
    const got = buildUploadArgv('  /bin/cp   -t   /srv/staging  ', DUMP);
    assert.deepEqual(got!.args, ['-t', '/srv/staging', DUMP]);
    assert.ok(!got!.args.includes(''));
  });

  test('the rclone form that was once documented puts the dump in the wrong place', () => {
    // Not an assertion that we support this - the opposite. It is pinned so the
    // wrong form cannot quietly come back into the runbook.
    const got = buildUploadArgv('/usr/bin/rclone copy --config /etc/two-bot/rclone.conf', DUMP);
    assert.equal(
      got!.args.at(-1),
      DUMP,
      'rclone copy SRC DST would read the dump as DST - use deploy/two-backup-upload',
    );
    assert.notEqual(got!.args.at(-2), DUMP);
  });
});

describe('the shipped wrapper', () => {
  test('takes the dump as $1 and puts it first, ahead of the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'two-upload-'));
    try {
      // deploy/two-backup-upload with the real tool swapped for a recorder, so
      // this asserts the wrapper's argument handling without needing rclone.
      const recorder = join(dir, 'recorder');
      const seen = join(dir, 'argv');
      writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > ${seen}\n`);
      chmodSync(recorder, 0o755);

      const wrapper = join(dir, 'two-backup-upload');
      const body = readFileSync(
        join(import.meta.dirname, '..', 'deploy', 'two-backup-upload'),
        'utf8',
      ).replace(
        /^exec \/usr\/bin\/rclone .*$/m,
        `exec ${recorder} copy --config /etc/two-bot/rclone.conf "$dump" backup:two-funnel`,
      );
      writeFileSync(wrapper, body);
      chmodSync(wrapper, 0o755);

      const dump = join(dir, 'two-funnel-20260824T041700Z.ndjson.gz');
      writeFileSync(dump, 'x');

      // Invoked exactly as pg-backup.ts would invoke it.
      const { cmd, args } = buildUploadArgv(wrapper, dump)!;
      execFileSync(cmd, args, { stdio: 'inherit' });

      const argv = readFileSync(seen, 'utf8').trimEnd().split('\n');
      assert.deepEqual(argv, [
        'copy',
        '--config',
        '/etc/two-bot/rclone.conf',
        dump,
        'backup:two-funnel',
      ]);
      // The point of the whole exercise: destination last, dump not last.
      assert.equal(argv.at(-1), 'backup:two-funnel');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses anything other than exactly one argument', () => {
    const wrapper = join(import.meta.dirname, '..', 'deploy', 'two-backup-upload');
    for (const args of [[], ['/tmp/a', '/tmp/b']]) {
      assert.throws(
        () => execFileSync('/bin/sh', [wrapper, ...args], { stdio: 'pipe' }),
        /status 2|Command failed/,
      );
    }
  });

  test('refuses a path that is not a file, rather than reporting a good upload', () => {
    const wrapper = join(import.meta.dirname, '..', 'deploy', 'two-backup-upload');
    assert.throws(
      () => execFileSync('/bin/sh', [wrapper, '/nonexistent/two-funnel.ndjson.gz'], { stdio: 'pipe' }),
      /status 2|Command failed/,
    );
  });
});

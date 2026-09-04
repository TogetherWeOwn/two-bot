/**
 * scripts/backup-upload-s3.ts and deploy/two-backup-upload, end to end.
 *
 * The unit tests pin the signature. They cannot catch what actually breaks an
 * off-box backup at 04:17: the wrapper passing the wrong argv, the uploader
 * exiting zero on an HTTP error, the object landing under a key nobody will
 * look under, or a failure being swallowed so systemd stays green while no
 * backup exists.
 *
 * So this runs the real script, and the real installed wrapper, as subprocesses
 * against test/helpers/fakeS3.ts - which re-derives the SigV4 signature from
 * the bytes it received and answers 403 on a mismatch, exactly as S3 would. An
 * upload that "worked" only because the receiver never checked would prove
 * nothing, so every passing upload here is a signature the server verified.
 *
 * The fake runs as a separate process on purpose: these tests drive the
 * uploader with execFileSync, which blocks this process's event loop, so an
 * in-process server could never answer the request we are blocked waiting on.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPLOADER = join(ROOT, 'scripts/backup-upload-s3.ts');
const WRAPPER = join(ROOT, 'deploy/two-backup-upload');
const FAKE = join(ROOT, 'test/helpers/fakeS3.ts');

const KEY_ID = 'AKIDEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const BUCKET = 'paperclip-backups';
const DUMP_NAME = 'two-funnel-20260903T041700Z.ndjson.gz';

interface Logged {
  method: string;
  url: string;
  body: string;
  length: number;
  signatureOk: boolean;
  authorization: string;
}

let child: ChildProcess;
let port: number;
let tmp: string;
let logPath: string;
let failPath: string;

/**
 * Make the fake S3 answer with an error for the next request. This is a file
 * rather than an env var because the fake is one long-lived process started in
 * `before` - an env var set here would never reach it.
 */
function failNextWith(spec: string): void {
  writeFileSync(failPath, spec);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'two-upload-'));
  logPath = join(tmp, 'requests.jsonl');
  failPath = join(tmp, 'fail');
  child = spawn(process.execPath, [FAKE, SECRET], {
    env: { ...process.env, FAKE_S3_LOG: logPath, FAKE_S3_FAIL_FILE: failPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake S3 did not start')), 15_000);
    child.stdout!.on('data', (d: Buffer) => {
      const m = /PORT (\d+)/.exec(d.toString());
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
});

after(() => {
  child?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test sees only its own requests, and starts with the store healthy.
  writeFileSync(logPath, '');
  writeFileSync(failPath, '');
});

/** Every request the fake S3 saw since the last test began. */
function requests(): Logged[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TWO_BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    TWO_BACKUP_S3_BUCKET: BUCKET,
    TWO_BACKUP_S3_ACCESS_KEY_ID: KEY_ID,
    TWO_BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
    ...extra,
  };
}

function run(cmd: string, args: string[], e: NodeJS.ProcessEnv) {
  try {
    const stdout = execFileSync(cmd, args, { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e2 = err as { status: number | null; stdout: string; stderr: string };
    return { code: e2.status ?? -1, stdout: e2.stdout ?? '', stderr: e2.stderr ?? '' };
  }
}

const upload = (args: string[], e = env()) => run(process.execPath, [UPLOADER, ...args], e);
/** Runs the wrapper exactly as pg-backup.ts would: one bare word, one argument. */
const wrapper = (args: string[], e = env()) => run('/bin/sh', [WRAPPER, ...args], { ...e, TWO_BOT_ROOT: ROOT });

function makeDump(name = DUMP_NAME, content = 'dump-bytes'): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe('backup-upload-s3 against a signature-checking server', () => {
  test('uploads the dump, and the server verifies the signature', () => {
    const r = upload([makeDump()]);
    assert.equal(r.code, 0, `expected success, got ${r.code}: ${r.stderr}`);
    const [req] = requests();
    assert.ok(req, 'no request reached the store');
    assert.equal(req.method, 'PUT');
    // The fake answers 403 unless it can re-derive the signature itself, so a
    // zero exit above already means the signature was accepted. Assert it
    // explicitly anyway - this is the property the whole card rests on.
    assert.equal(req.signatureOk, true);
    assert.equal(req.body, 'dump-bytes');
  });

  test('the object lands under bucket/filename, stamp preserved', () => {
    upload([makeDump()]);
    assert.equal(requests()[0]!.url, `/${BUCKET}/${DUMP_NAME}`);
  });

  test('a prefix is applied, in every spelling', () => {
    for (const p of ['two-bot', '/two-bot/']) {
      writeFileSync(logPath, '');
      const r = upload([makeDump()], env({ TWO_BACKUP_S3_PREFIX: p }));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(requests()[0]!.url, `/${BUCKET}/two-bot/${DUMP_NAME}`, p);
    }
  });

  test('a large dump uploads whole', () => {
    // 2 MiB, enough to cross the socket in many chunks: a signature computed
    // over a partially-read body would fail verification here.
    const r = upload([makeDump('big.ndjson.gz', 'x'.repeat(2 * 1024 * 1024))]);
    assert.equal(r.code, 0, r.stderr);
    const [req] = requests();
    assert.equal(req!.length, 2 * 1024 * 1024);
    assert.equal(req!.signatureOk, true);
  });

  test('a wrong secret is rejected by the server and fails the backup', () => {
    // Proves the fake is actually checking, and that we surface its refusal.
    const r = upload([makeDump()], env({ TWO_BACKUP_S3_SECRET_ACCESS_KEY: 'wrong-secret' }));
    assert.equal(r.code, 1, 'a signature the store rejects must fail the run');
    assert.match(r.stderr, /403/);
    assert.equal(requests()[0]!.signatureOk, false);
  });

  test('an HTTP error from the store is a failed backup, not a silent pass', () => {
    failNextWith('403:<Error><Code>AccessDenied</Code></Error>');
    const r = upload([makeDump()]);
    assert.equal(r.code, 1, 'a 403 must exit non-zero so systemd marks the timer failed');
    assert.match(r.stderr, /403/);
    assert.match(r.stderr, /AccessDenied/, 'the XML body distinguishes a bad key from a bad bucket');
  });

  test('a 500 from the store also fails', () => {
    failNextWith('500:<Error><Code>InternalError</Code></Error>');
    const r = upload([makeDump()]);
    assert.equal(r.code, 1);
  });

  test('missing configuration refuses by name and uploads nothing', () => {
    const e = env();
    delete e.TWO_BACKUP_S3_BUCKET;
    const r = upload([makeDump()], e);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TWO_BACKUP_S3_BUCKET/);
    assert.equal(requests().length, 0);
  });

  test('an empty dump is refused rather than uploaded', () => {
    const r = upload([makeDump('empty.ndjson.gz', '')]);
    assert.equal(r.code, 1);
    assert.equal(requests().length, 0, 'an empty backup must never reach the bucket');
  });

  test('a missing file is refused', () => {
    const r = upload([join(tmp, 'nope.gz')]);
    assert.equal(r.code, 1);
    assert.equal(requests().length, 0);
  });

  test('the wrong argument count is refused', () => {
    assert.equal(upload([]).code, 1);
    assert.equal(upload([makeDump(), 'extra']).code, 1);
    assert.equal(requests().length, 0);
  });

  test('the credential never appears in output or on the wire', () => {
    failNextWith('403:<Error><Code>AccessDenied</Code></Error>');
    const r = upload([makeDump()]);
    // stdout and stderr both land in the journal, which is widely readable.
    assert.ok(!`${r.stdout}${r.stderr}`.includes(SECRET), 'secret leaked into output');
    // The Authorization header carries a signature, never the secret itself.
    assert.ok(!requests()[0]!.authorization.includes(SECRET), 'secret leaked into the request');
  });
});

describe('deploy/two-backup-upload, the installed wrapper', () => {
  test('uploads through the same path with a single argument', () => {
    // Exactly the argv buildUploadArgv produces for a bare wrapper word.
    const r = wrapper([makeDump()]);
    assert.equal(r.code, 0, `wrapper failed: ${r.stderr}`);
    const [req] = requests();
    assert.equal(req!.url, `/${BUCKET}/${DUMP_NAME}`);
    assert.equal(req!.signatureOk, true);
  });

  test('rejects the wrong argument count before touching the network', () => {
    assert.equal(wrapper([]).code, 2);
    assert.equal(wrapper([makeDump(), 'extra']).code, 2);
    assert.equal(requests().length, 0);
  });

  test('rejects a path that is not a file', () => {
    assert.equal(wrapper([join(tmp, 'nope.gz')]).code, 2);
    assert.equal(requests().length, 0);
  });

  test('propagates an upload failure instead of swallowing it', () => {
    failNextWith('403:<Error><Code>AccessDenied</Code></Error>');
    const r = wrapper([makeDump()]);
    assert.notEqual(r.code, 0, 'the wrapper must not swallow a failed upload');
  });

  test('carries no destination of its own — env alone decides the bucket', () => {
    // The point of the rewrite: changing destination is an env edit, never a
    // reinstall of this file.
    const r = wrapper([makeDump()], env({ TWO_BACKUP_S3_BUCKET: 'some-other-bucket' }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests()[0]!.url, `/some-other-bucket/${DUMP_NAME}`);
  });
});

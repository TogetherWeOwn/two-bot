/**
 * The SigV4 signer and the off-box destination config.
 *
 * A signer is the kind of code that is either exactly right or completely
 * useless, and it fails in a way you cannot see by reading: a wrong canonical
 * string produces a perfectly well-formed signature that S3 rejects with a bare
 * 403. So these tests do not check that the code does what I meant. They check
 * it against AWS's own published worked example, whose expected signature is
 * fixed by the specification and not by this repository.
 *
 * The config tests exist for the opposite failure: a destination that defaults
 * instead of refusing writes the night's dump somewhere nobody looks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalPath, objectKey, signPut, signingKey, amzStamps } from '../src/store/s3Sign.ts';
import { loadS3Target, ConfigError, REQUIRED_VARS } from '../src/store/s3Config.ts';

const ENV = {
  TWO_BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  TWO_BACKUP_S3_BUCKET: 'paperclip-backups',
  TWO_BACKUP_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  TWO_BACKUP_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('signingKey', () => {
  /**
   * AWS's documented derivation example. Key, date, region and service are the
   * ones in the spec, and so is the expected hex - if this line ever needs
   * changing to make the suite pass, the signer is wrong, not the test.
   * https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
   */
  test('matches the AWS worked example', () => {
    const got = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
    assert.equal(got.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });

  test('a different date, region or service gives a different key', () => {
    const base = signingKey('secret', '20260903', 'auto', 's3').toString('hex');
    assert.notEqual(base, signingKey('secret', '20260904', 'auto', 's3').toString('hex'));
    assert.notEqual(base, signingKey('secret', '20260903', 'us-east-1', 's3').toString('hex'));
    assert.notEqual(base, signingKey('secret', '20260903', 'auto', 'iam').toString('hex'));
  });
});

describe('canonicalPath', () => {
  test('slashes separate segments and are not encoded', () => {
    assert.equal(canonicalPath('/paperclip-backups/two-bot/dump.gz'), '/paperclip-backups/two-bot/dump.gz');
  });

  test('spaces and S3-unsafe characters are percent-encoded', () => {
    assert.equal(canonicalPath('/b/a file.gz'), '/b/a%20file.gz');
    // encodeURIComponent leaves these alone; S3 does not. A key containing one
    // would sign locally and 403 on the wire.
    assert.equal(canonicalPath("/b/it's(1)!.gz"), '/b/it%27s%281%29%21.gz');
  });

  test('unreserved characters survive untouched', () => {
    assert.equal(canonicalPath('/b/two-funnel_20260903.ndjson.gz~'), '/b/two-funnel_20260903.ndjson.gz~');
  });

  test('non-ASCII is UTF-8 encoded bytewise', () => {
    assert.equal(canonicalPath('/b/café.gz'), '/b/caf%C3%A9.gz');
  });
});

describe('objectKey', () => {
  test('no prefix means the bare filename', () => {
    assert.equal(objectKey(undefined, 'dump.gz'), 'dump.gz');
    assert.equal(objectKey('', 'dump.gz'), 'dump.gz');
  });

  test('every spelling of a prefix normalises to exactly one', () => {
    // Three spellings must not become three prefixes: backups split across
    // them is a restore you cannot find.
    for (const p of ['two-bot', '/two-bot', 'two-bot/', '/two-bot/']) {
      assert.equal(objectKey(p, 'dump.gz'), 'two-bot/dump.gz');
    }
  });
});

describe('amzStamps', () => {
  test('produces the basic-format instant and its date', () => {
    const { amzDate, dateStamp } = amzStamps(new Date('2026-09-03T04:17:00.123Z'));
    assert.equal(amzDate, '20260903T041700Z');
    assert.equal(dateStamp, '20260903');
  });
});

describe('signPut', () => {
  const target = {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'paperclip-backups',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  const body = Buffer.from('funnel dump bytes');
  const at = new Date('2026-09-03T04:17:00Z');

  test('addresses the bucket path-style, as R2 requires', () => {
    const { url } = signPut(target, 'two-bot/dump.gz', body, at);
    assert.equal(url, 'https://acct.r2.cloudflarestorage.com/paperclip-backups/two-bot/dump.gz');
  });

  test('sends the real payload hash rather than UNSIGNED-PAYLOAD', () => {
    const { headers } = signPut(target, 'dump.gz', body, at);
    // The sha256 of the body itself, so a truncated upload cannot be accepted
    // as a whole one. Computed here independently of the signer.
    assert.equal(headers['x-amz-content-sha256'], createHash('sha256').update(body).digest('hex'));
    assert.equal(headers['content-length'], String(body.length));
  });

  test('signs exactly the headers it lists, and only stable ones', () => {
    const { headers } = signPut(target, 'dump.gz', body, at);
    const listed = /SignedHeaders=([^,]+)/.exec(headers['authorization']!)![1]!;
    assert.equal(listed, 'content-length;host;x-amz-content-sha256;x-amz-date');
    for (const h of listed.split(';')) assert.ok(headers[h] !== undefined, `${h} is signed but not sent`);
  });

  test('the credential scope carries the region and the s3 service', () => {
    const { headers } = signPut(target, 'dump.gz', body, at);
    assert.match(headers['authorization']!, /Credential=AKIDEXAMPLE\/20260903\/auto\/s3\/aws4_request/);
    assert.match(headers['authorization']!, /^AWS4-HMAC-SHA256 /);
    assert.match(headers['authorization']!, /Signature=[0-9a-f]{64}$/);
  });

  test('the signature covers the body', () => {
    const a = signPut(target, 'dump.gz', Buffer.from('one'), at).headers['authorization'];
    const b = signPut(target, 'dump.gz', Buffer.from('two'), at).headers['authorization'];
    assert.notEqual(a, b);
  });

  test('the signature covers the key, the bucket and the instant', () => {
    const base = signPut(target, 'dump.gz', body, at).headers['authorization'];
    assert.notEqual(base, signPut(target, 'other.gz', body, at).headers['authorization']);
    assert.notEqual(base, signPut({ ...target, bucket: 'other' }, 'dump.gz', body, at).headers['authorization']);
    assert.notEqual(base, signPut(target, 'dump.gz', body, new Date('2026-09-03T04:18:00Z')).headers['authorization']);
  });

  test('a trailing slash on the endpoint does not double up in the URL', () => {
    const { url } = signPut({ ...target, endpoint: 'https://acct.r2.cloudflarestorage.com/' }, 'd.gz', body, at);
    assert.equal(url, 'https://acct.r2.cloudflarestorage.com/paperclip-backups/d.gz');
  });
});

describe('loadS3Target', () => {
  test('accepts a complete environment', () => {
    const t = loadS3Target({ ...ENV, TWO_BACKUP_S3_PREFIX: 'two-bot/' });
    assert.equal(t.bucket, 'paperclip-backups');
    assert.equal(t.prefix, 'two-bot/');
  });

  test('region defaults to auto, which is what R2 wants', () => {
    assert.equal(loadS3Target(ENV).region, 'auto');
    assert.equal(loadS3Target({ ...ENV, TWO_BACKUP_S3_REGION: 'us-east-1' }).region, 'us-east-1');
  });

  test('every required variable is refused when missing, by name', () => {
    for (const name of REQUIRED_VARS) {
      const env: Record<string, string | undefined> = { ...ENV };
      delete env[name];
      assert.throws(() => loadS3Target(env), (e: Error) => e instanceof ConfigError && e.message.includes(name), name);
    }
  });

  test('blank and whitespace-only are missing, not empty values', () => {
    assert.throws(() => loadS3Target({ ...ENV, TWO_BACKUP_S3_BUCKET: '   ' }), ConfigError);
  });

  test('refuses plain http to a remote host', () => {
    // Would ship the funnel log and the signing credential in clear text.
    assert.throws(
      () => loadS3Target({ ...ENV, TWO_BACKUP_S3_ENDPOINT: 'http://acct.r2.cloudflarestorage.com' }),
      ConfigError,
    );
  });

  for (const endpoint of [
    'http://localhost:9000@remote.invalid',
    'http://127.0.0.1:9000@remote.invalid',
    'http://localhost.remote.invalid:9000',
    'http://127.0.0.1.remote.invalid:9000',
    'http://localhost\\@remote.invalid',
    'http://remote.invalid',
    'HTTP://remote.invalid',
    'http://192.0.2.1:9000',
  ]) {
    test(`refuses authority-confusion or non-loopback HTTP fixture: ${endpoint}`, () => {
      assert.throws(() => loadS3Target({ ...ENV, TWO_BACKUP_S3_ENDPOINT: endpoint }), ConfigError);
    });
  }

  for (const endpoint of [
    'https://store.invalid',
    'https://store.invalid/',
    'https://store.invalid:9443',
    'http://localhost:9000',
    'http://localhost:9000/',
    'http://127.0.0.1:9000',
    'HTTP://LOCALHOST:9000/',
  ]) {
    test(`preserves supported origin when signing: ${endpoint}`, () => {
      const target = loadS3Target({ ...ENV, TWO_BACKUP_S3_ENDPOINT: endpoint });
      const signed = signPut(target, 'fixture.gz', Buffer.from('fixture'), new Date('2026-09-03T04:17:00Z'));
      assert.equal(target.endpoint, endpoint);
      assert.equal(signed.url, `${new URL(endpoint).origin}/paperclip-backups/fixture.gz`);
      assert.equal(signed.headers.host, new URL(endpoint).host);
    });
  }

  for (const endpoint of [
    'https://fixture-user:fixture-password@store.invalid',
    'https://fixture-user@store.invalid',
    'https://@store.invalid',
    'http://fixture-user:fixture-password@localhost:9000',
    'https://store.invalid/proxy/s3',
    'https://store.invalid/proxy/..',
    'https://store.invalid//',
    'https://store.invalid/?fixture=value',
    'https://store.invalid/?',
    'https://store.invalid/#fixture',
    'https://store.invalid/#',
    'https://store.invalid:invalid',
    'https://[invalid]',
    'https://',
    'not-a-url',
    'ftp://store.invalid',
  ]) {
    test(`refuses malformed or unsupported endpoint fixture: ${endpoint}`, () => {
      assert.throws(
        () => loadS3Target({ ...ENV, TWO_BACKUP_S3_ENDPOINT: endpoint }),
        (error: Error) => error instanceof ConfigError &&
          error.message.includes('TWO_BACKUP_S3_ENDPOINT') &&
          !error.message.includes(endpoint) &&
          !error.message.includes('fixture-user') &&
          !error.message.includes('fixture-password'),
      );
    });
  }

  test('refuses an endpoint with no scheme', () => {
    assert.throws(() => loadS3Target({ ...ENV, TWO_BACKUP_S3_ENDPOINT: 'acct.r2.cloudflarestorage.com' }), ConfigError);
  });

  test('refuses a bucket name that would retarget the path-style URL', () => {
    // `a/b` would put the write in bucket `a` under key `b/...`.
    for (const bad of ['a/b', 'Paperclip-Backups', 'x', '']) {
      assert.throws(() => loadS3Target({ ...ENV, TWO_BACKUP_S3_BUCKET: bad }), ConfigError, bad);
    }
  });
});

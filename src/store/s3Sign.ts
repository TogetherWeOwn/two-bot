/**
 * AWS SigV4 for a single S3 PUT, in plain `node:crypto`.
 *
 * This exists because the off-box destination cannot depend on a binary the
 * host does not have. `scripts/bootstrap-host.sh` installs git, rsync, curl and
 * nodejs and nothing else - no `rclone`, no `aws`. That is the same test this
 * repo already applied to `pg_dump` in docs/RUNBOOK.md ("a backup procedure
 * that only works on a machine we do not have is not a backup procedure"), and
 * a destination that silently needs an uninstalled binary fails it the same
 * way: the nightly timer goes red at 04:17 with `ENOENT`, or worse, nobody
 * looks and the off-box copy that recovery depends on was never there.
 *
 * Scope is deliberately one request shape - PUT one object, whole, with a
 * payload hash we computed ourselves. No multipart, no listing, no streaming
 * signature. Backups are single files written once a night; the complexity that
 * a general S3 client carries would be untested weight.
 *
 * The canonical request and string-to-sign are AWS's, unchanged:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 * `test/unit.s3sign.test.ts` checks this signer against AWS's own published
 * worked example and against @smithy/signature-v4 on identical input, so the
 * implementation is pinned to the spec rather than to my reading of it.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional key prefix, e.g. `two-bot/`. Leading/trailing slashes are tidied. */
  prefix?: string;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

const UNSIGNED_IN_PATH = /[^A-Za-z0-9\-._~]/g;

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone and S3 does not,
 * so a key containing any of them would sign correctly and 403 on the wire.
 */
function uriEncode(value: string): string {
  return value.replace(UNSIGNED_IN_PATH, (c) => {
    const bytes = Buffer.from(c, 'utf8');
    let out = '';
    for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    return out;
  });
}

/** Each path segment is encoded separately: the `/` separators must survive. */
export function canonicalPath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

/** `20260903T041700Z` and `20260903`, the two stamps SigV4 wants. */
export function amzStamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** The four-step derivation: date, region, service, `aws4_request`. */
export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

/**
 * Joins a prefix and a filename into an object key. A prefix is normalised to
 * exactly one trailing slash and no leading one, so `/two-bot`, `two-bot` and
 * `two-bot/` all produce `two-bot/<file>` rather than three different keys -
 * three months of backups split across three prefixes is a restore you cannot
 * find.
 */
export function objectKey(prefix: string | undefined, filename: string): string {
  const clean = (prefix ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  return clean ? `${clean}/${filename}` : filename;
}

/**
 * Signs a PUT of `body` to `key`.
 *
 * Path-style addressing (`<endpoint>/<bucket>/<key>`) because that is what R2
 * serves and what `forcePathStyle: true` means everywhere else in this company's
 * storage config. Only host, content-length and the two x-amz headers are
 * signed - a signature over headers a proxy may rewrite is a signature that
 * fails in production and passes in tests.
 */
export function signPut(target: S3Target, key: string, body: Buffer, now: Date): SignedRequest {
  const endpoint = target.endpoint.replace(/\/+$/, '');
  const { host, protocol } = new URL(endpoint);
  const { amzDate, dateStamp } = amzStamps(now);
  const service = 's3';

  const payloadHash = sha256Hex(body);
  const path = canonicalPath(`/${target.bucket}/${key}`);

  const headers: Record<string, string> = {
    host,
    'content-length': String(body.length),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]!.trim()}\n`).join('');
  const signedHeaderList = signedHeaders.join(';');

  const canonicalRequest = [
    'PUT',
    path,
    '', // no query string on a plain PUT
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${target.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(target.secretAccessKey, dateStamp, target.region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return { url: `${protocol}//${host}${path}`, headers };
}

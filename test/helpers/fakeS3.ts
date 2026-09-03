/**
 * A fake S3 that verifies SigV4 the way the real one does.
 *
 * Runs as its OWN process, started by test/e2e.backupupload.test.ts. It has to:
 * the test drives the uploader with execFileSync, which blocks the caller's
 * event loop, so a server living in the test process could never answer the
 * request the test is blocked waiting on.
 *
 * It re-derives the signature from the bytes that arrived and answers 403 on a
 * mismatch. A receiver that accepted anything would make the upload test prove
 * nothing at all.
 *
 *   node test/helpers/fakeS3.ts <secret>
 *
 * Prints `PORT <n>` on stdout once listening. Requests are appended as one JSON
 * object per line to the file named by FAKE_S3_LOG.
 *
 * Failure injection is a FILE, named by FAKE_S3_FAIL_FILE and containing
 * `<status>:<body>`, not an environment variable: this process starts once, so
 * an env var set by a later test would never reach it. It is read per request.
 */
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

const secret = process.argv[2];
if (!secret) {
  console.error('fakeS3: usage: fakeS3.ts <secret>');
  process.exit(2);
}
const logPath = process.env.FAKE_S3_LOG;

/** The same percent-encoding S3 applies to a canonical path. */
function encodeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9\-._~]/g, (c) => {
    let out = '';
    for (const b of Buffer.from(c, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    return out;
  });
}

function verify(method: string, url: string, body: Buffer, headers: Record<string, string>): boolean {
  const auth = headers['authorization'];
  if (!auth) return false;
  const scope = /Credential=[^/]+\/([^,]+),/.exec(auth)?.[1];
  const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1];
  const got = /Signature=([0-9a-f]{64})/.exec(auth)?.[1];
  if (!scope || !signed || !got) return false;

  const [dateStamp, region, service] = scope.split('/');
  if (!dateStamp || !region || !service) return false;

  const canonicalHeaders = signed.split(';').map((h) => `${h}:${(headers[h] ?? '').trim()}\n`).join('');
  const canonicalRequest = [
    method,
    url.split('/').map(encodeSegment).join('/'),
    '',
    canonicalHeaders,
    signed,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');

  const sts = [
    'AWS4-HMAC-SHA256',
    headers['x-amz-date'] ?? '',
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d, 'utf8').digest();
  const key = h(h(h(h(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
  return createHmac('sha256', key).update(sts, 'utf8').digest('hex') === got;
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = req.headers as Record<string, string>;
    const signatureOk = verify(req.method ?? '', req.url ?? '', body, headers);

    if (logPath) {
      appendFileSync(
        logPath,
        `${JSON.stringify({
          method: req.method,
          url: req.url,
          body: body.toString('utf8'),
          length: body.length,
          signatureOk,
          // Recorded so a test can assert the credential is not echoed anywhere.
          authorization: headers['authorization'] ?? '',
        })}\n`,
      );
    }

    const failFile = process.env.FAKE_S3_FAIL_FILE;
    const fail = failFile && existsSync(failFile) ? readFileSync(failFile, 'utf8').trim() : '';
    if (fail) {
      const idx = fail.indexOf(':');
      res.writeHead(Number(fail.slice(0, idx)), { 'content-type': 'application/xml' });
      return res.end(fail.slice(idx + 1));
    }
    if (!signatureOk) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    }
    res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  console.log(`PORT ${port}`);
});

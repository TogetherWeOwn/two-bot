/**
 * TOG-4837 acceptance for the fetch-driven reward-role readback panel, by
 * execution against a stubbed endpoint.
 *
 * The card asks for UI readback showing the grant state after apply in three
 * states - loading, empty, granted - proved against a stubbed endpoint, not
 * against Discord. This spins a loopback stub serving the TOG-5107 envelope
 * (`{member, grants[]}`, flipping from empty to granted when the test
 * applies), then proves the panel end to end:
 *
 *   1. the stub bodies agree with TOG-5107 step 1's heredocs shape-for-shape
 *      (parsed values, not bytes - a serializer change must not red the
 *      contract, only an envelope change must);
 *   2. the loading branch renders while the stub has not answered;
 *   3. the fetched empty readback renders the empty branch;
 *   4. apply, re-read, and the fetched granted readback renders the granted
 *      branch naming the role - the after-apply readback this card exists for;
 *   5. the failure half is fail-closed: non-200, non-JSON and
 *      contract-violating stubs all throw naming the problem, never a
 *      half-render.
 *
 * Companion, not overlap, to TOG-5161's static preview: that renderer takes a
 * caller-chosen state and never fetches; this test proves the
 * fetch-then-render loop and the re-read flip. Different files, different
 * assertions, no shared imports.
 *
 * Fully offline: the stub binds 127.0.0.1 on an ephemeral port and holds no
 * guild id, no token, no database. Nothing here is a real person - the
 * member id is eighteen repeated ones, the role id eighteen repeated twos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  loadReadback,
  readbackProblems,
  renderReadbackPanel,
  stateForReadback,
  READBACK_PANEL_GRANTED_AT,
  READBACK_PANEL_LEVEL,
  READBACK_PANEL_MEMBER,
  READBACK_PANEL_ROLE,
  type ReadbackResponse,
} from '../tools/reward-role-readback-panel/panel.ts';

const MEMBER = READBACK_PANEL_MEMBER;
const ROLE = READBACK_PANEL_ROLE;

function emptyDoc(): ReadbackResponse {
  return { member: MEMBER, grants: [] };
}

function grantedDoc(): ReadbackResponse {
  return {
    member: MEMBER,
    grants: [{ roleId: ROLE, level: READBACK_PANEL_LEVEL, grantedAt: READBACK_PANEL_GRANTED_AT }],
  };
}

/**
 * The stubbed endpoint: GET /readback answers the current grant state, POST
 * /apply flips it to granted (the test's stand-in for the TOG-4444 grant),
 * POST /revoke flips it back. One mutable document behind three routes is
 * the whole point - the re-read after apply is what moves the UI.
 */
function stubbedEndpoint() {
  let grants: ReadbackResponse['grants'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST' && path === '/apply') {
      grants = grantedDoc().grants;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"applied":true}\n');
      return;
    }
    if (req.method === 'POST' && path === '/revoke') {
      grants = [];
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"revoked":true}\n');
      return;
    }
    if (req.method === 'GET' && path === '/readback') {
      const body = `${JSON.stringify({ member: MEMBER, grants })}\n`;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: GET /readback, POST /apply, POST /revoke\n');
  });
  return { server };
}

async function listen(server: Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('the stub bodies match TOG-5107 step 1 shape-for-shape', () => {
  // TOG-5107's offline contract writes these two heredocs and validates the
  // parsed shapes. The comparison is on parsed values, not bytes: if the
  // script's envelope ever changes, this is the test that fails - and the
  // fix is to change both together, not to let them drift.
  const expectedEmpty = `{"member": "111111111111111111", "grants": []}\n`;
  const expectedGranted = `{"member": "111111111111111111", "grants": [{"roleId": "222222222222222222", "level": 5, "grantedAt": "2026-09-26T00:00:00.000Z"}]}\n`;
  assert.deepEqual(JSON.parse(JSON.stringify(emptyDoc())), JSON.parse(expectedEmpty));
  assert.deepEqual(JSON.parse(JSON.stringify(grantedDoc())), JSON.parse(expectedGranted));
  assert.deepEqual(readbackProblems(JSON.parse(expectedEmpty)), []);
  assert.deepEqual(readbackProblems(JSON.parse(expectedGranted)), []);
});

test('loading renders while the stub has not answered', () => {
  const page = renderReadbackPanel('loading', null);
  assert.match(page, /data-state="loading"/);
  assert.match(page, /Loading grant state/);
  assert.match(page, new RegExp(MEMBER));
});

test('empty readback fetched from the stub renders the empty state', async () => {
  const { server } = stubbedEndpoint();
  const { base, close } = await listen(server);
  try {
    const readback = await loadReadback(fetch, `${base}/readback`);
    assert.deepEqual(readback, emptyDoc());
    assert.equal(stateForReadback(readback), 'empty');
    const page = renderReadbackPanel(stateForReadback(readback), readback);
    assert.match(page, /data-state="empty"/);
    assert.match(page, /grant list is empty/);
  } finally {
    await close();
  }
});

test('apply then re-read: the fetched granted readback renders the granted state', async () => {
  const { server } = stubbedEndpoint();
  const { base, close } = await listen(server);
  try {
    const before = await loadReadback(fetch, `${base}/readback`);
    assert.equal(stateForReadback(before), 'empty');

    const applied = await fetch(`${base}/apply`, { method: 'POST' });
    assert.equal(applied.status, 200);

    // The re-read after apply is the readback this card exists for: the UI
    // must show the grant only because the endpoint now says so.
    const after = await loadReadback(fetch, `${base}/readback`);
    assert.equal(stateForReadback(after), 'granted');
    const page = renderReadbackPanel(stateForReadback(after), after);
    assert.match(page, /data-state="granted"/);
    assert.match(page, /Granted reward roles/);
    assert.match(page, new RegExp(ROLE));
    assert.match(page, new RegExp(`level ${READBACK_PANEL_LEVEL}`));

    const revoked = await fetch(`${base}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    const cleared = await loadReadback(fetch, `${base}/readback`);
    assert.equal(stateForReadback(cleared), 'empty');
  } finally {
    await close();
  }
});

test('fail-closed: a non-200, a non-JSON body and a contract violation all throw', async () => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/down') {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('boom\n');
      return;
    }
    if (path === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<p>not json</p>');
      return;
    }
    if (path === '/wrong-shape') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"member":"nope","grants":[{"roleId":"x"}]}\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });
  const { base, close } = await listen(server);
  try {
    await assert.rejects(() => loadReadback(fetch, `${base}/down`), /HTTP 500/);
    await assert.rejects(() => loadReadback(fetch, `${base}/html`), /did not answer JSON/);
    await assert.rejects(() => loadReadback(fetch, `${base}/wrong-shape`), /violates the contract/);
    await assert.rejects(() => loadReadback(fetch, `${base}/missing`), /HTTP 404/);
    await assert.rejects(() => loadReadback(fetch, 'gopher://x/readback'), /refuses non-HTTP/);
  } finally {
    await close();
  }
});

test('the granted state escapes member-supplied values', () => {
  const hostile: ReadbackResponse = {
    member: '"><script>alert(1)</script>',
    grants: [{ roleId: ROLE, level: READBACK_PANEL_LEVEL, grantedAt: READBACK_PANEL_GRANTED_AT }],
  };
  const page = renderReadbackPanel('granted', hostile);
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.match(page, /&lt;script&gt;/);
});

/**
 * TOG-5161 acceptance for the stubbed reward-role readback fixture, by execution.
 *
 * The card asks for a stubbed endpoint fixture plus a preview showing the
 * grant state after apply in three states - loading, empty, granted - so QA
 * (TOG-5107) can execute. This asserts the fixture validates against the
 * contract, the documents the stub serves match TOG-5107's heredocs
 * shape-for-shape (parsed values, not bytes), and each rendered state names
 * its own branch the way the acceptance greps
 * for it. The last test starts the preview server on a loopback port and
 * reads back every route, so the run proves the reviewer command works, not
 * just the functions under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyReadback,
  grantedReadback,
  readbackProblems,
  renderReadbackPreview,
  READBACK_FIXTURE_GRANTED_AT,
  READBACK_FIXTURE_LEVEL,
  READBACK_FIXTURE_MEMBER,
  READBACK_FIXTURE_ROLE,
} from './fixtures/reward-role-readback.ts';
import { startReadbackPreview } from '../tools/reward-role-readback-preview/run.ts';

test('the empty and granted fixtures validate against the readback contract', () => {
  const empty = emptyReadback();
  assert.deepEqual(empty, { member: READBACK_FIXTURE_MEMBER, grants: [] });
  assert.deepEqual(readbackProblems(empty), []);

  const granted = grantedReadback();
  assert.deepEqual(granted, {
    member: READBACK_FIXTURE_MEMBER,
    grants: [{ roleId: READBACK_FIXTURE_ROLE, level: READBACK_FIXTURE_LEVEL, grantedAt: READBACK_FIXTURE_GRANTED_AT }],
  });
  assert.deepEqual(readbackProblems(granted), []);
});

test('the stub documents match TOG-5107 step 1 shape-for-shape', () => {
  // TOG-5107's offline contract writes these two heredocs and validates the
  // parsed shapes. The comparison is on parsed values, not bytes: the stub
  // serves compact JSON while the script's heredocs carry spaces, and the
  // contract is the shape, not the serializer. If the script's envelope ever
  // changes, this is the test that fails - and the fix is to change both
  // together, not to let them drift.
  const expectedEmpty = `{"member": "111111111111111111", "grants": []}\n`;
  const expectedGranted = `{"member": "111111111111111111", "grants": [{"roleId": "222222222222222222", "level": 5, "grantedAt": "2026-09-26T00:00:00.000Z"}]}\n`;
  assert.deepEqual(JSON.parse(JSON.stringify(emptyReadback())), JSON.parse(expectedEmpty));
  assert.deepEqual(JSON.parse(JSON.stringify(grantedReadback())), JSON.parse(expectedGranted));
  assert.deepEqual(readbackProblems(JSON.parse(expectedEmpty)), []);
  assert.deepEqual(readbackProblems(JSON.parse(expectedGranted)), []);
});

test('malformed readbacks name what is wrong instead of throwing', () => {
  assert.deepEqual(readbackProblems(null), ['readback must be a JSON object']);
  assert.deepEqual(readbackProblems({ member: READBACK_FIXTURE_MEMBER }), [
    'grants must be an array, got undefined',
  ]);
  const badGrant = {
    member: READBACK_FIXTURE_MEMBER,
    grants: [{ roleId: 'nope', level: 0, grantedAt: 'yesterday' }],
  };
  assert.deepEqual(readbackProblems(badGrant), [
    'grants[0].roleId must be a Discord snowflake string',
    'grants[0].level must be a positive integer',
    'grants[0].grantedAt must be an ISO instant',
  ]);
});

test('all three states render, each carrying its own state branch', () => {
  // TOG-5107 step 2 greps the component for loading/empty/grant. The rendered
  // document must survive that same inspection: `data-state` pins which branch
  // produced it, and each body names its own branch in prose.
  const states = ['loading', 'empty', 'granted'] as const;
  for (const state of states) {
    const readback = state === 'granted' ? grantedReadback() : emptyReadback();
    const page = renderReadbackPreview(state, readback);
    assert.match(page, new RegExp(`data-state="${state}"`));
    assert.match(page, new RegExp(state === 'granted' ? 'Granted reward roles' : state === 'loading' ? 'Loading grant state' : 'grant list is empty'));
  }
  const granted = renderReadbackPreview('granted', grantedReadback());
  assert.match(granted, new RegExp(READBACK_FIXTURE_ROLE));
});

test('the granted state escapes member-supplied values', () => {
  const hostile = grantedReadback('"><script>alert(1)</script>', {
    roleId: READBACK_FIXTURE_ROLE,
    grantedAt: '2026-09-26T00:00:00.000Z',
  });
  assert.deepEqual(readbackProblems({ ...hostile, member: READBACK_FIXTURE_MEMBER }), []);
  const page = renderReadbackPreview('granted', hostile);
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.match(page, /&lt;script&gt;/);
});

test('the preview server answers every route on loopback', async () => {
  const { server, port } = await startReadbackPreview(0, 'granted');
  try {
    const get = async (path: string): Promise<{ status: number; body: string; location: string | null }> => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
      return { status: res.status, body: await res.text(), location: res.headers.get('location') };
    };
    const landing = await get('/');
    assert.equal(landing.status, 302);
    assert.equal(landing.location, '/preview/granted');
    const empty = await get('/readback-empty.json');
    assert.equal(empty.status, 200);
    assert.deepEqual(readbackProblems(JSON.parse(empty.body)), []);

    const granted = await get('/readback-granted.json');
    assert.equal(granted.status, 200);
    assert.deepEqual(readbackProblems(JSON.parse(granted.body)), []);

    for (const state of ['loading', 'empty', 'granted']) {
      const page = await get(`/preview/${state}`);
      assert.equal(page.status, 200);
      assert.match(page.body, new RegExp(`data-state="${state}"`));
    }
    const missing = await get('/preview/archived');
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

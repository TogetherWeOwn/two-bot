/**
 * Raid removal, run for real as a process against a stub Discord.
 *
 * The unit tests prove the engine's decisions. They cannot prove that the
 * script wires the engine to a real socket, a real file and a real exit code —
 * and on a tool whose job is removing members, "the units passed" is not the
 * assurance anyone needs. So these cases spawn `scripts/raid-remove.ts` the way
 * an operator would and check the three things that would actually hurt:
 *
 *   - a dry run that reaches Discord anyway. The stub counts its requests; a
 *     dry run must leave that counter at zero.
 *   - a second run that removes somebody twice. The stub records every DELETE.
 *   - a run that is killed halfway and cannot be resumed.
 *
 * No test here can reach the real API: the base override the script accepts is
 * loopback-only, and that restriction is itself a case below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/raid-remove.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUILD = '326474832151838730';

const ID = (n: number) => String(100000000000000000n + BigInt(n));

interface Stub {
  base: string;
  /** Every DELETE the script issued, in order. */
  deletes: string[];
  requests: number;
  close: () => Promise<void>;
}

/** `status(memberId, attemptIndexForThatMember)` -> the HTTP status to answer with. */
async function stubDiscord(status: (memberId: string, attempt: number) => number): Promise<Stub> {
  const deletes: string[] = [];
  const attempts = new Map<string, number>();
  let requests = 0;

  const server: Server = createServer((req, res) => {
    requests++;
    const m = /\/guilds\/(\d+)\/members\/(\d+)$/.exec(req.url ?? '');
    if (req.method !== 'DELETE' || !m) {
      res.writeHead(400).end();
      return;
    }
    const memberId = m[2]!;
    const n = attempts.get(memberId) ?? 0;
    attempts.set(memberId, n + 1);
    const code = status(memberId, n);
    if (code === 204) deletes.push(memberId);
    if (code === 429) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ retry_after: 0.01 }));
      return;
    }
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(code === 204 ? '' : JSON.stringify({ message: 'stub' }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    deletes,
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: REPO,
        env: {
          ...process.env,
          DISCORD_TOKEN: 'stub-token',
          DISCORD_GUILD_ID: GUILD,
          ...env,
        },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function fixture(n: number): { dir: string; list: string; audit: string; ids: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'two-raid-e2e-'));
  const ids = Array.from({ length: n }, (_, i) => ID(i));
  const list = join(dir, 'targets.txt');
  writeFileSync(list, ['# produced by scripts/raid-list.ts --ids', ...ids].join('\n') + '\n');
  return { dir, list, audit: join(dir, 'audit.jsonl'), ids };
}

function auditLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('the default invocation contacts Discord zero times and still names every account', async () => {
  const stub = await stubDiscord(() => 204);
  const f = fixture(3);
  try {
    const r = await runScript(['--ids-from', f.list, '--audit', f.audit], {
      RAID_REMOVE_API_BASE: stub.base,
    });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.equal(stub.requests, 0, 'a dry run must not open a single request');
    assert.equal(stub.deletes.length, 0);

    const lines = auditLines(f.audit);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.outcome === 'would_kick' && l.mode === 'dry-run'));
    for (const id of f.ids) assert.match(r.stdout, new RegExp(id));
  } finally {
    await stub.close();
  }
});

test('--execute removes each account once and writes a line for each', async () => {
  const stub = await stubDiscord(() => 204);
  const f = fixture(4);
  try {
    const r = await runScript(
      ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '4'],
      { RAID_REMOVE_API_BASE: stub.base },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(stub.deletes, f.ids);

    const lines = auditLines(f.audit);
    assert.equal(lines.length, 4);
    assert.ok(lines.every((l) => l.outcome === 'kicked' && l.status === 204 && l.action === 'kick'));
    assert.ok(lines.every((l) => typeof l.ts === 'string' && Date.parse(l.ts as string) > 0));
  } finally {
    await stub.close();
  }
});

test('running the exact same command a second time removes nobody', async () => {
  const stub = await stubDiscord(() => 204);
  const f = fixture(4);
  const args = ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '4'];
  try {
    await runScript(args, { RAID_REMOVE_API_BASE: stub.base });
    assert.equal(stub.deletes.length, 4);

    const r = await runScript(args, { RAID_REMOVE_API_BASE: stub.base });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stub.deletes.length, 4, 'the second run must issue no removals');
    assert.equal(auditLines(f.audit).length, 4, 'and must not re-stamp settled lines');
    assert.match(r.stdout, /skipped_done/);
  } finally {
    await stub.close();
  }
});

test('a run that dies halfway resumes on the untouched accounts and finishes the job', async () => {
  // The server revokes the permission after two removals, so the run aborts on
  // the third consecutive 403. Then the permission comes back.
  let revoked = true;
  const done = new Set<string>();
  const stub = await stubDiscord((id) => {
    if (done.has(id)) return 404;
    if (revoked && done.size >= 2) return 403;
    done.add(id);
    return 204;
  });
  const f = fixture(8);
  const args = ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '8'];
  try {
    const first = await runScript(args, { RAID_REMOVE_API_BASE: stub.base });
    assert.equal(first.code, 1, 'an aborted run must not exit 0');
    assert.match(first.stderr, /ABORTED/);
    assert.equal(stub.deletes.length, 2);

    revoked = false;
    const second = await runScript(args, { RAID_REMOVE_API_BASE: stub.base });
    assert.equal(second.code, 0, second.stderr);

    // Every account ends up removed exactly once, across the two runs.
    assert.equal(stub.deletes.length, 8);
    assert.equal(new Set(stub.deletes).size, 8);

    const terminal = auditLines(f.audit).filter(
      (l) => l.outcome === 'kicked' || l.outcome === 'already_gone',
    );
    assert.equal(new Set(terminal.map((l) => l.memberId)).size, 8);
  } finally {
    await stub.close();
  }
});

test('an account that left on its own is recorded as already gone, and the run still succeeds', async () => {
  const stub = await stubDiscord((id) => (id === ID(1) ? 404 : 204));
  const f = fixture(3);
  try {
    const r = await runScript(
      ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '3'],
      { RAID_REMOVE_API_BASE: stub.base },
    );
    assert.equal(r.code, 0, r.stderr);
    const byId = new Map(auditLines(f.audit).map((l) => [l.memberId, l.outcome]));
    assert.equal(byId.get(ID(1)), 'already_gone');
    assert.equal(byId.get(ID(0)), 'kicked');
  } finally {
    await stub.close();
  }
});

test('rate limiting is waited out rather than skipped over', async () => {
  const stub = await stubDiscord((_id, attempt) => (attempt === 0 ? 429 : 204));
  const f = fixture(3);
  try {
    const r = await runScript(
      ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '3'],
      { RAID_REMOVE_API_BASE: stub.base },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(stub.deletes, f.ids);
    assert.ok(
      auditLines(f.audit).every((l) => l.outcome === 'kicked' && (l.attempts as number) === 2),
    );
  } finally {
    await stub.close();
  }
});

test('--execute without --expect refuses, and nothing is written', async () => {
  const stub = await stubDiscord(() => 204);
  const f = fixture(3);
  try {
    const r = await runScript(['--ids-from', f.list, '--audit', f.audit, '--execute'], {
      RAID_REMOVE_API_BASE: stub.base,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--expect/);
    assert.equal(stub.requests, 0);
    assert.equal(auditLines(f.audit).length, 0);
  } finally {
    await stub.close();
  }
});

test('a count that disagrees with the file stops the run before any request', async () => {
  const stub = await stubDiscord(() => 204);
  const f = fixture(3);
  try {
    const r = await runScript(
      ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '19'],
      { RAID_REMOVE_API_BASE: stub.base },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--expect 19 but .* has 3 unique ids/);
    assert.equal(stub.requests, 0);
  } finally {
    await stub.close();
  }
});

test('--execute with no token says where the credential is not, instead of hunting for one', async () => {
  const f = fixture(2);
  const r = await runScript(
    ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '2'],
    { DISCORD_TOKEN: '', DISCORD_BOT_TOKEN: '' },
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TOG-432/);
  assert.equal(auditLines(f.audit).length, 0);
});

test('the API base override refuses any host that is not loopback', async () => {
  const f = fixture(2);
  const r = await runScript(
    ['--ids-from', f.list, '--audit', f.audit, '--execute', '--expect', '2'],
    { RAID_REMOVE_API_BASE: 'https://evil.example.com/api/v10' },
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only accepts loopback/);
});

test('the committed server audit is rejected as a target list, by name', async () => {
  const f = fixture(1);
  const r = await runScript(['--ids-from', 'data/server-audit-2026-08-19.json', '--audit', f.audit]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no member identities/);
});

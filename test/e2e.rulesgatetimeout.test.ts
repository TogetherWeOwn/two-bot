import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/rules-gate-timeout.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUILD = '326474832151838730';
const NOW = '2026-09-04T12:00:00.000Z';
const ID = (n: number) => String(100000000000000000n + BigInt(n));

interface StubMember {
  user: { id: string; bot?: boolean };
  joined_at: string;
  pending?: boolean;
  roles: string[];
}

interface Stub {
  base: string;
  requests: string[];
  deletes: string[];
  close: () => Promise<void>;
}

async function stubDiscord(members: StubMember[]): Promise<Stub> {
  const requests: string[] = [];
  const deletes: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url?.startsWith(`/api/v10/guilds/${GUILD}/members?`)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(members));
      return;
    }
    const match = new RegExp(`^/api/v10/guilds/${GUILD}/members/(\\d+)$`).exec(req.url ?? '');
    if (req.method === 'DELETE' && match) {
      deletes.push(match[1]!);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    requests,
    deletes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runScript(
  args: string[],
  base: string,
  audit: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, '--now', NOW, '--audit', audit, ...args],
      {
        cwd: REPO,
        env: {
          ...process.env,
          DISCORD_TOKEN: 'stub-token',
          DISCORD_GUILD_ID: GUILD,
          RULES_GATE_TIMEOUT_API_BASE: base,
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

function auditLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const roster = (): StubMember[] => [
  { user: { id: ID(1) }, joined_at: '2026-08-01T00:00:00.000Z', pending: true, roles: [] },
  { user: { id: ID(2) }, joined_at: '2026-08-21T12:00:00.000Z', pending: true, roles: [] },
  { user: { id: ID(3) }, joined_at: '2026-08-25T00:00:00.000Z', pending: true, roles: [] },
  { user: { id: ID(4) }, joined_at: '2026-01-01T00:00:00.000Z', pending: false, roles: [] },
  { user: { id: ID(5), bot: true }, joined_at: '2026-01-01T00:00:00.000Z', pending: true, roles: [] },
];

test('default mode names targets, audits each, and sends no DELETE', async () => {
  const stub = await stubDiscord(roster());
  const audit = join(mkdtempSync(join(tmpdir(), 'two-gate-e2e-')), 'audit.jsonl');
  try {
    const run = await runScript([], stub.base, audit);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /REPORT ONLY/);
    assert.match(run.stdout, /pending for at least 14 days/);
    assert.match(run.stdout, new RegExp(ID(1)));
    assert.match(run.stdout, new RegExp(ID(2)));
    assert.doesNotMatch(run.stdout, new RegExp(ID(3)));
    assert.deepEqual(stub.deletes, []);
    assert.equal(stub.requests.filter((request) => request.startsWith('GET ')).length, 1);
    assert.equal(stub.requests.filter((request) => request.startsWith('DELETE ')).length, 0);
    const lines = auditLines(audit);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line.outcome === 'would_kick' && line.action === 'kick'));
  } finally {
    await stub.close();
  }
});

test('--execute requires a matching expectation before deleting anyone', async () => {
  const stub = await stubDiscord(roster());
  const audit = join(mkdtempSync(join(tmpdir(), 'two-gate-e2e-')), 'audit.jsonl');
  try {
    const missing = await runScript(['--execute'], stub.base, audit);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--expect/);
    assert.deepEqual(stub.deletes, []);

    const mismatch = await runScript(['--execute', '--expect', '31'], stub.base, audit);
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.stderr, /live report has 2 target/);
    assert.deepEqual(stub.deletes, []);
    assert.equal(auditLines(audit).length, 0);
  } finally {
    await stub.close();
  }
});

test('--execute --expect kicks every target and no other member', async () => {
  const stub = await stubDiscord(roster());
  const audit = join(mkdtempSync(join(tmpdir(), 'two-gate-e2e-')), 'audit.jsonl');
  try {
    const run = await runScript(['--execute', '--expect', '2'], stub.base, audit);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(stub.deletes, [ID(1), ID(2)]);
    assert.ok(auditLines(audit).every((line) => line.outcome === 'kicked' && line.action === 'kick'));
  } finally {
    await stub.close();
  }
});

test('the API override refuses a non-loopback host', async () => {
  const audit = join(mkdtempSync(join(tmpdir(), 'two-gate-e2e-')), 'audit.jsonl');
  const run = await runScript([], 'https://example.com/api/v10', audit);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /only accepts loopback/);
});

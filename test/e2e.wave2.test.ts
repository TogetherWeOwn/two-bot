/**
 * Wave 2, run for real against a stub Discord.
 *
 * The planner is unit-tested next door; this file exists because the half that
 * can actually damage the live server is the half that issues HTTP, and a dry
 * run proves the guards rather than the call. So the stub records every
 * request and the cases below assert on what was sent, not on what was printed:
 *
 *   - the dry run issues no write at all
 *   - --apply POSTs six objects and nothing else, with no DELETE/PATCH/PUT
 *   - ⚙️ SYSTEM leaves with its @everyone View deny attached
 *   - #looking-to-play is parented to the CHAT category that was just created
 *   - a second --apply against the finished server writes nothing
 *   - a failed create is reported and exits non-zero rather than claiming success
 *   - the wrong bot or the wrong guild stops before any write
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = new URL('../scripts/wave2-additive.ts', import.meta.url).pathname;
const REPO = new URL('..', import.meta.url).pathname;

const GUILD = '326474832151838730';
const OWEN = '1539711683898118154';
const VIEW_CHANNEL = (1n << 10n).toString();

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface StubState {
  channels: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  /** Paths that should answer 500 no matter what, to force a failed create. */
  failCreates?: boolean;
  botId?: string;
}

async function stubDiscord(state: StubState) {
  const requests: Recorded[] = [];
  let nextId = 9000;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/api\/v10/, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      requests.push({ method: req.method ?? '', path, body });
      const json = (code: number, payload: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (path === '/users/@me') return json(200, { id: state.botId ?? OWEN, username: 'Owen' });
      if (path === `/guilds/${GUILD}`) return json(200, { id: GUILD, name: 'TogetherWeOwn' });
      if (path === `/guilds/${GUILD}/channels` && req.method === 'GET') return json(200, state.channels);
      if (path === `/guilds/${GUILD}/roles` && req.method === 'GET') return json(200, state.roles);
      if (path === `/guilds/${GUILD}/channels` && req.method === 'POST') {
        if (state.failCreates) return json(500, { message: 'stub failure' });
        const made = { id: String(nextId++), ...body };
        state.channels.push(made);
        return json(201, made);
      }
      if (path === `/guilds/${GUILD}/roles` && req.method === 'POST') {
        if (state.failCreates) return json(500, { message: 'stub failure' });
        const made = { id: String(nextId++), ...body };
        state.roles.push(made);
        return json(201, made);
      }
      return json(404, { message: 'not stubbed' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function runScript(base: string, args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout } = await run('node', [SCRIPT, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: 'stub',
        DISCORD_GUILD_ID: GUILD,
        WAVE2_API_BASE: base,
        ...env,
      },
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** A server that has none of the Wave 2 objects yet. */
const freshState = (): StubState => ({
  channels: [{ id: '1', name: '💬〢general', type: 0 }],
  roles: [{ id: GUILD, name: '@everyone' }],
});

const writes = (rs: Recorded[]) => rs.filter((r) => r.method !== 'GET');

test('wave2: a dry run issues no write of any kind', async () => {
  const stub = await stubDiscord(freshState());
  const { code, stdout } = await runScript(stub.base, []);
  await stub.close();
  assert.equal(code, 0);
  assert.match(stdout, /6 object\(s\) to create/);
  assert.deepEqual(writes(stub.requests), [], 'a dry run must not write');
});

test('wave2: --apply creates exactly the six objects, and only ever POSTs', async () => {
  const stub = await stubDiscord(freshState());
  const { code, stdout } = await runScript(stub.base, ['--apply']);
  await stub.close();
  assert.equal(code, 0, stdout);
  const w = writes(stub.requests);
  assert.equal(w.length, 6, '4 categories + 1 channel + 1 role');
  // The additive guarantee, asserted rather than described.
  assert.deepEqual([...new Set(w.map((r) => r.method))], ['POST']);
  assert.equal(w.filter((r) => r.path.endsWith('/channels')).length, 5);
  assert.equal(w.filter((r) => r.path.endsWith('/roles')).length, 1);
  assert.match(stdout, /Wave 2 complete and verified by re-read/);
});

test('wave2: ⚙️ SYSTEM is created already denying @everyone View', async () => {
  const stub = await stubDiscord(freshState());
  await runScript(stub.base, ['--apply']);
  await stub.close();
  const system = writes(stub.requests).find((r) => r.body?.name === '⚙️ SYSTEM');
  assert.ok(system, 'SYSTEM was created');
  const ow = system.body?.permission_overwrites as Array<Record<string, string>>;
  assert.equal(ow.length, 1);
  assert.equal(ow[0]?.id, GUILD, "@everyone's role id is the guild id");
  assert.equal(ow[0]?.deny, VIEW_CHANNEL);

  // And the three visible categories carry no overwrite at all.
  for (const name of ['📌 START HERE', '💬 CHAT', '🔊 VOICE']) {
    const cat = writes(stub.requests).find((r) => r.body?.name === name);
    assert.deepEqual(cat?.body?.permission_overwrites, [], `${name} inherits @everyone`);
  }
});

test('wave2: #looking-to-play is parented to the CHAT category just created', async () => {
  const stub = await stubDiscord(freshState());
  await runScript(stub.base, ['--apply']);
  await stub.close();
  const w = writes(stub.requests);
  const chat = w.find((r) => r.body?.name === '💬 CHAT');
  const chan = w.find((r) => r.body?.name === 'looking-to-play');
  assert.ok(chat && chan);
  // The id the stub minted for CHAT must be the parent the channel was sent with.
  const chatId = (stub.state.channels.find((c) => c.name === '💬 CHAT') as { id: string }).id;
  assert.equal(chan.body?.parent_id, chatId);
  assert.match(String(chan.body?.topic), /Anyone up for anything/);
});

test('wave2: re-running --apply on a finished server writes nothing', async () => {
  const stub = await stubDiscord(freshState());
  await runScript(stub.base, ['--apply']);
  const afterFirst = writes(stub.requests).length;
  const { code, stdout } = await runScript(stub.base, ['--apply']);
  await stub.close();
  assert.equal(code, 0, stdout);
  assert.equal(writes(stub.requests).length, afterFirst, 'the second run created nothing');
  assert.match(stdout, /already present/);
});

test('wave2: a failed create exits 1 rather than reporting success', async () => {
  const stub = await stubDiscord({ ...freshState(), failCreates: true });
  const { code, stdout } = await runScript(stub.base, ['--apply']);
  await stub.close();
  assert.equal(code, 1);
  assert.match(stdout, /ERROR/);
  assert.match(stdout, /failed write/);
  assert.doesNotMatch(stdout, /Wave 2 complete/);
});

test('wave2: the wrong bot identity stops before any write', async () => {
  const stub = await stubDiscord({ ...freshState(), botId: '456483983870394368' });
  const { code, stdout } = await runScript(stub.base, ['--apply']);
  await stub.close();
  assert.equal(code, 2);
  assert.deepEqual(writes(stub.requests), []);
  assert.match(stdout, /not Owen/);
});

test('wave2: a guild id that is not TWO stops before any write', async () => {
  const stub = await stubDiscord(freshState());
  const { code, stdout } = await runScript(stub.base, ['--apply'], {
    DISCORD_GUILD_ID: '1545644954272137297',
  });
  await stub.close();
  assert.equal(code, 2);
  assert.deepEqual(writes(stub.requests), []);
  assert.match(stdout, /not the TWO server/);
});

test('wave2: the onboarding-catalog warning is printed on every run', async () => {
  const stub = await stubDiscord({
    channels: [],
    // The real catalog role ids, present and non-managed, so they are "doomed".
    roles: [{ id: GUILD, name: '@everyone' }, { id: '1051272877871222915', name: 'Shooter Games' }],
  });
  const { stdout } = await runScript(stub.base, []);
  await stub.close();
  assert.match(stdout, /deleted by Wave 6/);
  assert.match(stdout, /Shooter Games/);
});

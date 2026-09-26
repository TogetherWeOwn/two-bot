/**
 * Stubbed reward-role readback endpoint plus three-state preview (TOG-5161).
 *
 *   node tools/reward-role-readback-preview/run.ts
 *   node tools/reward-role-readback-preview/run.ts --port 4317 --state granted
 *
 * Serves, on loopback only: the JSON readback stub QA's acceptance needs
 * (TOG-5107 step 1 validates `/readback-empty.json` and
 * `/readback-granted.json`), and `/preview/<state>` rendering each UI state
 * against that stub. `--state` only changes which document `/` redirects to,
 * so a reviewer can land on loading, empty or granted first without changing
 * what the endpoints serve.
 *
 * STAGING-ONLY PREVIEW, OFFLINE. No bot token, no database, no Discord: the
 * granted state is a fixed fixture, not a live guild readback. The empty and
 * granted documents match TOG-5107's heredocs shape-for-shape (parsed values,
 * not bytes - the stub serves compact JSON), so the script's offline contract
 * check passes against this server unchanged.
 *
 * This is a dev tool. It is never imported by src/.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  emptyReadback,
  grantedReadback,
  type ReadbackUiState,
  renderReadbackPreview,
} from '../../test/fixtures/reward-role-readback.ts';

export const DEFAULT_PORT = 4317;
const STATES: ReadonlyArray<ReadbackUiState> = ['loading', 'empty', 'granted'];

function json(res: ServerResponse, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res: ServerResponse, state: ReadbackUiState): void {
  const body = renderReadbackPreview(state, state === 'granted' ? grantedReadback() : emptyReadback());
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function startReadbackPreview(
  port: number = DEFAULT_PORT,
  landing: ReadbackUiState = 'empty',
): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(302, { location: `/preview/${landing}` });
      res.end();
      return;
    }
    if (path === '/readback-empty.json') {
      json(res, emptyReadback());
      return;
    }
    if (path === '/readback-granted.json') {
      json(res, grantedReadback());
      return;
    }
    const preview = path.match(/^\/preview\/(loading|empty|granted)\/?$/);
    if (preview) {
      html(res, preview[1] as ReadbackUiState);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: /readback-empty.json, /readback-granted.json, /preview/<loading|empty|granted>\n');
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return { server, port: bound };
}

const invokedDirectly = process.argv[1] !== undefined && /reward-role-readback-preview[/\\]run\.ts$/.test(process.argv[1]);

if (invokedDirectly) {
  let port = DEFAULT_PORT;
  let landing: ReadbackUiState = 'empty';
  for (const [index, arg] of process.argv.entries()) {
    if (arg === '--port') port = Number(process.argv[index + 1]);
    if (arg === '--state' && STATES.includes(process.argv[index + 1] as ReadbackUiState)) {
      landing = process.argv[index + 1] as ReadbackUiState;
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`readback-preview: --port must be 1-65535, got ${process.argv.join(' ')}`);
    process.exit(2);
  }
  const { port: bound } = await startReadbackPreview(port, landing);
  console.log('readback preview listening (loopback only, stubbed data, no Discord)');
  console.log(`  stubbed endpoint: http://127.0.0.1:${bound}/readback-granted.json`);
  console.log(`  three states:     ${STATES.map((s) => `http://127.0.0.1:${bound}/preview/${s}`).join(' ')}`);
  console.log(`  landing state:    ${landing} (via --state loading|empty|granted)`);
}

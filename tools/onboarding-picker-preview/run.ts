/**
 * Stubbed onboarding picker endpoint plus five-state preview (TOG-4962).
 *
 *   node tools/onboarding-picker-preview/run.ts
 *   node tools/onboarding-picker-preview/run.ts --port 4318 --state picked
 *
 * Serves, on loopback only: the JSON picker stub the review needs
 * (`/picker-empty.json` with no options, `/picker-session.json` with the two
 * session options), and `/preview/<state>` rendering each UI state against
 * that stub. `--state` only changes which document `/` redirects to, so a
 * reviewer can land on loading, empty, picked, unavailable or stale first
 * without changing what the endpoints serve.
 *
 * STAGING-ONLY PREVIEW, OFFLINE. No bot token, no database, no Discord: both
 * documents are fixed fixtures, not live reads. The copy inside them is
 * pinned to the bot's real strings by the unit test, not by trust.
 *
 * This is a dev tool. It is never imported by src/.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  emptyPicker,
  PICKER_STATES,
  renderPickerPreview,
  sessionPicker,
  type PickerUiState,
} from '../../test/fixtures/onboarding-picker-copy.ts';

export const DEFAULT_PORT = 4318;

function json(res: ServerResponse, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res: ServerResponse, state: PickerUiState): void {
  const picker = state === 'loading' || state === 'empty' ? emptyPicker() : sessionPicker();
  const body = renderPickerPreview(state, picker);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function startPickerPreview(
  port: number = DEFAULT_PORT,
  landing: PickerUiState = 'empty',
): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(302, { location: `/preview/${landing}` });
      res.end();
      return;
    }
    if (path === '/picker-empty.json') {
      json(res, emptyPicker());
      return;
    }
    if (path === '/picker-session.json') {
      json(res, sessionPicker());
      return;
    }
    const preview = path.match(/^\/preview\/(loading|empty|picked|unavailable|stale)\/?$/);
    if (preview) {
      html(res, preview[1] as PickerUiState);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      'not found: /picker-empty.json, /picker-session.json, /preview/<loading|empty|picked|unavailable|stale>\n',
    );
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return { server, port: bound };
}

const invokedDirectly =
  process.argv[1] !== undefined && /onboarding-picker-preview[/\\]run\.ts$/.test(process.argv[1]);

if (invokedDirectly) {
  let port = DEFAULT_PORT;
  let landing: PickerUiState = 'empty';
  for (const [index, arg] of process.argv.entries()) {
    if (arg === '--port') port = Number(process.argv[index + 1]);
    if (arg === '--state' && (PICKER_STATES as readonly string[]).includes(process.argv[index + 1] as string)) {
      landing = process.argv[index + 1] as PickerUiState;
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`picker-preview: --port must be 1-65535, got ${process.argv.join(' ')}`);
    process.exit(2);
  }
  const { port: bound } = await startPickerPreview(port, landing);
  console.log('picker preview listening (loopback only, stubbed data, no Discord)');
  console.log(`  stubbed endpoint: http://127.0.0.1:${bound}/picker-session.json`);
  console.log(`  five states:      ${PICKER_STATES.map((s) => `http://127.0.0.1:${bound}/preview/${s}`).join(' ')}`);
  console.log(`  landing state:    ${landing} (via --state ${PICKER_STATES.join('|')})`);
}

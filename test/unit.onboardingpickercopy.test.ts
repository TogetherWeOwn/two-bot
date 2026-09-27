/**
 * TOG-4962 acceptance for the stubbed onboarding picker-copy fixture, by execution.
 *
 * The card asks for onboarding empty-states and role-picker copy behind a
 * preview flag, with no live-guild action. This asserts the fixture validates
 * against the contract, the copy agrees with the bot's real strings (computed
 * from `sessionWelcomeText`/`sessionAckText` or grepped from the adapter
 * source, never copy-pasted on trust), the preview flag gates off by default,
 * and each rendered state names its own branch the way the reviewer greps
 * for it. The last test starts the preview server on a loopback port and
 * reads back every route, so the run proves the reviewer command works, not
 * just the functions under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyPicker,
  ONBOARDING_PICKER_PREVIEW_FLAG,
  pickerCopyProbes,
  pickerPreviewEnabled,
  pickerProblems,
  PICKER_STATES,
  renderPickerPreview,
  routedAck,
  sessionPicker,
  staleAck,
  unavailableAck,
  WELCOME_PROBE,
} from './fixtures/onboarding-picker-copy.ts';
import { startPickerPreview } from '../tools/onboarding-picker-preview/run.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the empty and session fixtures validate against the picker contract', () => {
  const empty = emptyPicker();
  assert.deepEqual(empty.options, []);
  assert.deepEqual(pickerProblems(empty), []);

  const session = sessionPicker();
  assert.deepEqual(
    session.options.map((o) => o.key),
    ['find-players', 'join-voice'],
  );
  assert.deepEqual(
    session.options.map((o) => o.label),
    ['Find people to play with', 'Join voice now'],
  );
  assert.deepEqual(pickerProblems(session), []);
});

test('malformed pickers name what is wrong instead of throwing', () => {
  assert.deepEqual(pickerProblems(null), ['picker must be a JSON object']);
  assert.deepEqual(pickerProblems({ ...emptyPicker(), options: 'soon' }).slice(0, 1), [
    'options must be an array, got "soon"',
  ]);
  const noHeading = pickerProblems({ ...emptyPicker(), heading: '  ' });
  assert.ok(noHeading.some((p) => p.startsWith('heading must be a non-empty string')));
  const badOption = pickerProblems({
    ...sessionPicker(),
    options: [{ key: 'x', label: '', description: 'd', emoji: 'e' }],
  });
  assert.ok(badOption.some((p) => p === 'options[0].label must be a non-empty string'));
});

test('the fixture copy agrees with the bot by execution, not by trust', () => {
  // Welcome heading + intro lead come out of the real sessionWelcomeText.
  const probes = pickerCopyProbes();
  assert.ok(WELCOME_PROBE.includes(probes.heading), 'sessionWelcomeText moved its opening line');
  assert.ok(
    WELCOME_PROBE.includes(probes.introLead),
    'sessionWelcomeText moved its picker question',
  );
  assert.ok(
    emptyPicker().intro.includes(probes.introLead),
    'fixture intro drifted from sessionWelcomeText',
  );
  // The Discord select placeholder lives in the adapter (discord.js, not
  // importable here), so the probe reads it as source text - the same way
  // scripts/onboarding-web-slice-acceptance.ts pins its contract lines.
  const welcomeSrc = readFileSync(join(ROOT, 'src/discord/sessionWelcome.ts'), 'utf8');
  assert.ok(
    welcomeSrc.includes(`.setPlaceholder('${probes.placeholder}')`),
    'session Discord placeholder moved; fixture placeholder must follow',
  );
  // The three ack branches are computed from the real planSession +
  // sessionAckText over the fixture catalog: exact match pins both sides.
  assert.equal(routedAck(), 'On it - head to <#444444444444444444>.');
  assert.equal(
    unavailableAck(),
    'Those rooms are not open to you right now.\n' +
      'Nothing was changed - try again in a moment, or say hello in the welcome channel and someone will grab you.',
  );
  assert.equal(
    staleAck(),
    'That option is gone or stale - the panel was probably replaced by a newer one.\n' +
      'Nothing was changed. Open the picker again and choose afresh.',
  );
});

test('the preview flag is off unless explicitly 1', () => {
  assert.equal(pickerPreviewEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(pickerPreviewEnabled({ [ONBOARDING_PICKER_PREVIEW_FLAG]: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(pickerPreviewEnabled({ [ONBOARDING_PICKER_PREVIEW_FLAG]: 'true' } as NodeJS.ProcessEnv), false);
  assert.equal(pickerPreviewEnabled({ [ONBOARDING_PICKER_PREVIEW_FLAG]: '1' } as NodeJS.ProcessEnv), true);
});

test('each of the five states renders its own branch', () => {
  const loading = renderPickerPreview('loading', null);
  assert.ok(loading.includes('data-state="loading"') && loading.includes('data-testid="picker-loading"'));

  const empty = renderPickerPreview('empty', emptyPicker());
  assert.ok(
    empty.includes('data-state="empty"') &&
      empty.includes('data-testid="picker-empty-title"') &&
      empty.includes('Nothing to pick right now.'),
  );

  const picked = renderPickerPreview('picked', sessionPicker());
  assert.ok(
    picked.includes('data-state="picked"') &&
      picked.includes('data-testid="picker-ack"') &&
      picked.includes('On it - head to') &&
      picked.includes('data-key="find-players"') &&
      picked.includes('data-key="join-voice"'),
  );

  const unavailable = renderPickerPreview('unavailable', sessionPicker());
  assert.ok(
    unavailable.includes('data-state="unavailable"') &&
      unavailable.includes('Those rooms are not open to you right now.'),
  );

  const stale = renderPickerPreview('stale', sessionPicker());
  assert.ok(
    stale.includes('data-state="stale"') &&
      stale.includes('role="alert"') &&
      stale.includes('That option is gone or stale'),
  );
});

test('option text is escaped where it renders', () => {
  const evil = sessionPicker();
  evil.options[0] = { key: 'x', label: '<b>&"q"</b>', description: 'd', emoji: 'e' };
  const html = renderPickerPreview('picked', evil);
  assert.ok(!html.includes('<b>') && html.includes('&lt;b&gt;&amp;&quot;q&quot;&lt;/b&gt;'));
});

test('the preview server answers every route on loopback', async () => {
  const { server, port } = await startPickerPreview(0, 'empty');
  try {
    const get = async (path: string): Promise<{ status: number; body: string }> => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
      return { status: res.status, body: await res.text() };
    };
    const landing = await get('/');
    assert.equal(landing.status, 302);

    const emptyJson = await get('/picker-empty.json');
    assert.equal(emptyJson.status, 200);
    assert.deepEqual(JSON.parse(emptyJson.body).options, []);

    const sessionJson = await get('/picker-session.json');
    assert.equal(sessionJson.status, 200);
    assert.deepEqual(
      (JSON.parse(sessionJson.body).options as Array<{ key: string }>).map((o) => o.key),
      ['find-players', 'join-voice'],
    );

    for (const state of PICKER_STATES) {
      const page = await get(`/preview/${state}`);
      assert.equal(page.status, 200, `preview/${state} did not answer 200`);
      assert.ok(page.body.includes(`data-state="${state}"`), `preview/${state} renders the wrong branch`);
    }

    const missing = await get('/no-such-route');
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

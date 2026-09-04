import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const service = readFileSync(join(ROOT, 'deploy', 'two-bot-rules-gate-timeout.service'), 'utf8');
const timer = readFileSync(join(ROOT, 'deploy', 'two-bot-rules-gate-timeout.timer'), 'utf8');
const bootstrap = readFileSync(join(ROOT, 'scripts', 'bootstrap-host.sh'), 'utf8');

test('the installed daily unit is report-only and reads the systemd credential', () => {
  const exec = service.match(/^ExecStart=(.+)$/m)?.[1];
  assert.equal(exec, '/usr/bin/node /opt/two-bot/scripts/rules-gate-timeout.ts');
  assert.doesNotMatch(exec!, /--execute|--expect/);
  assert.match(service, /^LoadCredential=discord_token:/m);
  assert.match(service, /^ReadWritePaths=\/opt\/two-bot\/data$/m);
});

test('the timer runs daily and is persistent', () => {
  assert.match(timer, /^OnCalendar=\*-\*-\* 04:43:00$/m);
  assert.match(timer, /^Persistent=true$/m);
});

test('bootstrap installs and enables the timeout timer', () => {
  assert.match(
    bootstrap,
    /^\s*"\$SRC\/deploy\/two-bot-rules-gate-timeout\.service" \\$/m,
  );
  assert.match(
    bootstrap,
    /^\s*"\$SRC\/deploy\/two-bot-rules-gate-timeout\.timer" \\$/m,
  );
  const enable = bootstrap.split('\n').find((line) => line.startsWith('systemctl enable --now '));
  assert.ok(enable);
  assert.match(enable!, /two-bot-rules-gate-timeout\.timer/);
});

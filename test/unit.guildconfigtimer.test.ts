import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const service = readFileSync(join(ROOT, 'deploy', 'two-bot-guild-config-backup.service'), 'utf8');
const timer = readFileSync(join(ROOT, 'deploy', 'two-bot-guild-config-backup.timer'), 'utf8');
const bootstrap = readFileSync(join(ROOT, 'scripts', 'bootstrap-host.sh'), 'utf8');

test('guild configuration backup uses the provisioned staging token path and staging guild guard', () => {
  assert.match(service, /^LoadCredential=discord_staging_token:\/etc\/two-bot\/credentials\/discord_staging_token$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/two-bot\/two-bot\.env$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/two-bot\/scripts\/guild-config-snapshot\.ts$/m);
  assert.match(service, /^ReadWritePaths=\/var\/backups\/two-bot\/guild-config$/m);
});

test('guild configuration timer is installed and conditionally enabled by bootstrap', () => {
  assert.match(timer, /^Persistent=true$/m);
  assert.match(bootstrap, /^\s*"\$SRC\/deploy\/two-bot-guild-config-backup\.service" \\$/m);
  assert.match(bootstrap, /^\s*"\$SRC\/deploy\/two-bot-guild-config-backup\.timer" \\$/m);
  assert.match(bootstrap, /^STAGING_TOKEN_FILE="\$CRED_DIR\/discord_staging_token"$/m);
  assert.match(bootstrap, /\[ -s "\$STAGING_TOKEN_FILE" \].*DISCORD_STAGING_GUILD_ID.*1545644954272137297/s);
  assert.match(bootstrap, /^\s*systemctl enable --now two-bot-guild-config-backup\.timer$/m);
  assert.match(bootstrap, /^\s*systemctl disable --now two-bot-guild-config-backup\.timer/m);
  const unconditional = bootstrap.split('\n').find((line) => line.startsWith('systemctl enable --now two-bot '));
  assert.ok(unconditional);
  assert.doesNotMatch(unconditional, /guild-config/);
});

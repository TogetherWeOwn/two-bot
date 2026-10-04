// TOG-5713. deploy/ is installed by hand (`sudo cp deploy/...`) and neither
// `npm test` nor typecheck ever looked at it, so a typo in a unit file only
// surfaced on the host at `systemctl enable` time. docker-compose.yml had the
// same gap: Coolify rejects a bad compose at deploy time, which is the most
// expensive place to learn about an indentation slip.
//
// This suite is the fence. Every `*.service` / `*.timer` in deploy/ is
// validated on every run - discovered from the directory, so a new unit is
// covered without anyone remembering to register it. Validation is two-tier:
// `systemd-analyze verify` where the binary exists (CI runners, where systemd
// ships), else a small in-test parser that enforces the invariants a broken
// unit actually violates (missing ExecStart, bad Type, timer with no
// calendar, Unit= pointing at nothing). Compose gets structural lint without
// a YAML dependency, and the Dockerfile gets hadolint-style basics.
//
// The failure cases below are staged from synthetic fixtures, not by breaking
// the real files: a guard nobody has watched fail is not a guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DEPLOY = join(ROOT, 'deploy');

interface UnitLine {
  key: string;
  value: string;
  line: number;
}

interface ParsedUnit {
  path: string;
  sections: Map<string, UnitLine[]>;
}

const KNOWN_SERVICE_TYPES = new Set([
  'simple',
  'exec',
  'forking',
  'oneshot',
  'dbus',
  'notify',
  'notify-reload',
  'idle',
]);

/** Parse a systemd unit file, joining backslash continuations first. */
function parseUnit(text: string, path: string): ParsedUnit {
  // systemd joins a line ending in `\` with the next line before parsing.
  // The restore-drill ExecStart relies on this, so the parser must too or it
  // would see a truncated command.
  const joined: string[] = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1);
      continue;
    }
    joined.push(pending + line);
    pending = '';
  }
  if (pending !== '') joined.push(pending);

  const sections = new Map<string, UnitLine[]>();
  let current: string | null = null;
  joined.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const section = line.match(/^\[(.+)\]$/);
    if (section?.[1]) {
      current = section[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      return;
    }
    const kv = line.match(/^([A-Za-z0-9]+)=(.*)$/);
    if (kv?.[1] && current !== null) {
      sections.get(current)?.push({ key: kv[1], value: kv[2] ?? '', line: i + 1 });
    } else if (current === null) {
      throw new Error(`${path}:${i + 1}: content outside any section: ${line}`);
    }
  });
  return { path, sections };
}

function getAll(unit: ParsedUnit, section: string, key: string): UnitLine[] {
  return (unit.sections.get(section) ?? []).filter((l) => l.key === key);
}

function getOne(unit: ParsedUnit, section: string, key: string): UnitLine | undefined {
  return getAll(unit, section, key)[0];
}

/**
 * The parser-tier checks. Returns problem strings; empty means the unit is
 * acceptable. Pure function of the parsed unit plus the deploy/ listing, so
 * the broken-fixture tests below exercise it without touching disk.
 */
function checkUnit(unit: ParsedUnit, deployFiles: string[]): string[] {
  const problems: string[] = [];
  const name = unit.path.split('/').pop() ?? unit.path;
  const isService = name.endsWith('.service');
  const isTimer = name.endsWith('.timer');

  const desc = getOne(unit, 'Unit', 'Description');
  if (!desc || desc.value.trim() === '') {
    problems.push(`${name}: [Unit] Description is missing or empty`);
  }

  if (isService) {
    const exec = getOne(unit, 'Service', 'ExecStart');
    if (!exec || exec.value.trim() === '') {
      problems.push(`${name}: [Service] ExecStart is missing - the unit would start nothing`);
    } else {
      const argv0 = exec.value.trim().split(/\s+/)[0] ?? '';
      if (!argv0.startsWith('/')) {
        problems.push(`${name}: ExecStart must be an absolute path, got: ${argv0}`);
      }
    }
    const type = getOne(unit, 'Service', 'Type');
    if (type && !KNOWN_SERVICE_TYPES.has(type.value.trim())) {
      problems.push(`${name}: [Service] Type=${type.value} is not a known service type`);
    }
    // Backup-style units are started by their timer and carry no [Install];
    // anything else must be enable-able on its own.
    const base = name.replace(/\.service$/, '');
    const pairedTimer = `${base}.timer`;
    if (!getOne(unit, 'Install', 'WantedBy') && !deployFiles.includes(pairedTimer)) {
      problems.push(`${name}: [Install] WantedBy is missing and no paired ${pairedTimer} exists`);
    }
  }

  if (isTimer) {
    const cal = getOne(unit, 'Timer', 'OnCalendar');
    if (!cal || cal.value.trim() === '') {
      problems.push(`${name}: [Timer] OnCalendar is missing - the timer would never fire`);
    }
    if (!getOne(unit, 'Install', 'WantedBy')) {
      problems.push(`${name}: [Install] WantedBy is missing - the timer cannot be enabled`);
    }
    const unitRef = getOne(unit, 'Timer', 'Unit');
    if (unitRef && !deployFiles.includes(unitRef.value.trim())) {
      problems.push(`${name}: [Timer] Unit=${unitRef.value} does not exist in deploy/`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// TOG-5688. Hardening invariants: every unit carries the same sandbox, restart
// policy is deliberate per type, and secrets never bake into Environment=.
// ---------------------------------------------------------------------------

/** Secret env names that must never appear as `Environment=NAME=` literals. */
// Twin of SECRET_ENV in scripts/ci/check-systemd-credentials.sh (R1): the
// shell guard runs in CI, these parser checks run under `npm test`. Adding a
// secret means updating both lists.
const SECRET_ENV_NAMES = new Set([
  'DISCORD_TOKEN',
  'DISCORD_BOT_TOKEN',
  'TWO_DATABASE_URL',
  'TWO_RESTORE_URL',
  'TWO_INTERNAL_KEYS',
  'DISCORD_STAGING_BOT_TOKEN',
  'TWO_E2E_USER_TOKEN',
  'TWO_MODERATION_AUDIT_SECRET',
  'TWO_BACKUP_S3_ENDPOINT',
  'TWO_BACKUP_S3_BUCKET',
  'TWO_BACKUP_S3_ACCESS_KEY_ID',
  'TWO_BACKUP_S3_SECRET_ACCESS_KEY',
]);

// Directives every service carries. Values differ per unit (MemoryMax 192M vs
// 512M), so entries without a `value` assert presence only: the number is a
// capacity decision, the presence is the invariant.
const REQUIRED_SANDBOX: ReadonlyArray<{ key: string; value?: string }> = [
  { key: 'NoNewPrivileges', value: 'true' },
  { key: 'PrivateTmp', value: 'true' },
  { key: 'ProtectSystem', value: 'strict' },
  { key: 'ProtectHome', value: 'true' },
  { key: 'UMask', value: '0077' },
  { key: 'CapabilityBoundingSet', value: '' },
  { key: 'MemoryMax' },
];

/**
 * The hardening-tier checks. Pure function of the parsed unit, so the
 * broken-fixture tests below exercise it without touching disk.
 */
function checkHardening(unit: ParsedUnit): string[] {
  const problems: string[] = [];
  const name = unit.path.split('/').pop() ?? unit.path;
  if (!name.endsWith('.service')) return problems;
  const svc = (key: string) => getAll(unit, 'Service', key);

  for (const { key, value } of REQUIRED_SANDBOX) {
    const found = svc(key)[0];
    if (!found) {
      problems.push(`${name}: [Service] ${key} is missing - every unit carries the shared sandbox baseline`);
    } else if (value !== undefined && found.value.trim() !== value) {
      problems.push(
        `${name}: [Service] ${key}=${found.value} must be ${value === '' ? 'empty' : value} - the baseline is identical everywhere`,
      );
    }
  }

  // Secrets travel as LoadCredential files or EnvironmentFile entries, never
  // baked into the unit (docs/SECRETS.md rule 3).
  for (const env of svc('Environment')) {
    const varName = env.value.split('=')[0]?.trim() ?? '';
    if (SECRET_ENV_NAMES.has(varName)) {
      problems.push(
        `${name}: [Service] Environment=${varName}=... bakes a secret into the unit - use LoadCredential, never env`,
      );
    }
  }

  // Credential source files are root-owned 600 under one directory, provisioned
  // by scripts/bootstrap-host.sh. A credential pointing anywhere else is either
  // a typo or a file nobody provisions.
  for (const cred of svc('LoadCredential')) {
    const src = cred.value.split(':')[1]?.trim() ?? '';
    if (!src.startsWith('/etc/two-bot/credentials/')) {
      problems.push(
        `${name}: [Service] LoadCredential source ${src || '(empty)'} is outside /etc/two-bot/credentials/`,
      );
    }
  }

  const type = getOne(unit, 'Service', 'Type')?.value.trim() ?? 'simple';
  const restart = getOne(unit, 'Service', 'Restart')?.value.trim();
  if (type === 'oneshot') {
    // Timer-started oneshots must stay failed when they fail: the timer refires
    // on schedule, and a Restart= loop would hide the failure.
    if (restart !== undefined) {
      problems.push(
        `${name}: [Service] oneshot units carry no Restart= (got ${restart}) - the timer refires; a failed run must stay failed`,
      );
    }
  } else {
    if (restart !== 'always' && restart !== 'on-failure') {
      problems.push(
        `${name}: [Service] long-running units need Restart=always (got ${restart ?? 'missing'}) - the bot comes back without anyone noticing`,
      );
    }
    if (!getOne(unit, 'Service', 'RestartSec')) {
      problems.push(
        `${name}: [Service] RestartSec is missing - restart without backoff burns the Discord identify budget silently`,
      );
    }
    // The crash-loop cap lives in [Unit]: systemd 255+ ignores StartLimit* in
    // [Service] and the cap is silently dropped (TOG-9539: hosted CI caught
    // three units claiming a cap that was never enforced).
    for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
      if (!getOne(unit, 'Unit', key)) {
        problems.push(
          `${name}: [Unit] ${key} is missing - restart without a crash-loop cap burns the Discord identify budget silently`,
        );
      }
    }
  }

  // A cap in [Service] is a comment, not a cap - flag the misplacement on any
  // unit type so the next one fails here instead of on a hosted runner.
  for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
    if (getOne(unit, 'Service', key)) {
      problems.push(
        `${name}: [Service] ${key} belongs in [Unit] - systemd 255+ ignores it here, so the crash-loop cap is silently dropped`,
      );
    }
  }

  return problems;
}

/**
 * `systemd-analyze verify` lines that describe the verifying machine, not the
 * unit. /usr/bin/node is the bootstrap contract (scripts/bootstrap-host.sh
 * installs Node so every unit pins the interpreter); hosted CI runners carry
 * node under the toolcache instead, so "not executable: No such file" for
 * exactly this path is environmental. Anything else missing - a typo'd
 * interpreter, a wrong path - still fails, because that would fail on the
 * host too.
 */
function isEnvironmentalVerifyNoise(line: string): boolean {
  return line.includes('/usr/bin/node') && line.includes('No such file or directory');
}

function verifyWithSystemd(path: string): string | null {
  let stderr = '';
  try {
    execFileSync('systemd-analyze', ['verify', path], { encoding: 'utf8', stdio: 'pipe' });
    return null;
  } catch (err) {
    stderr =
      err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
    if (!stderr.trim()) {
      const msg = err instanceof Error ? err.message : String(err);
      return `${path}: systemd-analyze verify failed: ${msg.trim().split('\n')[0]}`;
    }
  }
  const real = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !isEnvironmentalVerifyNoise(l));
  if (real.length === 0) {
    // Loud skip, same philosophy as a missing binary: the parser tier above
    // already ran, and silence would hide that this tier contributed nothing.
    console.log(
      `${path}: systemd-analyze verify reports only the missing host node - parser-tier checks are the gate here`,
    );
    return null;
  }
  return `${path}: systemd-analyze verify failed: ${real[0]}`;
}

/** `systemd-analyze verify` where the binary exists; null when it does not. */
function systemdVerifyAvailable(): boolean {
  try {
    execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // ENOENT = no systemd on this machine (containers, macOS). Anything else
    // (EACCES, ...) also means verify cannot run here - the parser covers it.
    if (err instanceof Error && 'code' in err) return false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Real files: every unit in deploy/ validates.
// ---------------------------------------------------------------------------

function deployUnitFiles(): string[] {
  return readdirSync(DEPLOY)
    .filter((f) => f.endsWith('.service') || f.endsWith('.timer'))
    .sort();
}

test('every unit in deploy/ parses and satisfies the structural checks', () => {
  const files = deployUnitFiles();
  assert.ok(files.length > 0, 'deploy/ contains no unit files at all');
  const problems: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(DEPLOY, f), 'utf8');
    let unit: ParsedUnit;
    try {
      unit = parseUnit(text, f);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    problems.push(...checkUnit(unit, files));
    problems.push(...checkHardening(unit));
  }
  assert.deepEqual(problems, [], `deploy/ unit problems:\n${problems.join('\n')}`);
});

test('systemd-analyze verify passes where systemd exists, parser covers the rest', () => {
  // On machines without systemd (this container, macOS) there is nothing to
  // run and the structural test above is the whole gate. Skipping loudly
  // rather than failing: absence of the binary is environmental, not a bug.
  if (!systemdVerifyAvailable()) {
    console.log('systemd-analyze not found - parser-tier checks are the gate here');
    return;
  }
  const failures: string[] = [];
  for (const f of deployUnitFiles()) {
    const failure = verifyWithSystemd(join(DEPLOY, f));
    if (failure) failures.push(failure);
  }
  assert.deepEqual(failures, [], `systemd-analyze verify failures:\n${failures.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Fixtures: the checks above must fail on deliberately broken units.
// ---------------------------------------------------------------------------

function fixtureProblems(name: string, text: string, deployFiles: string[] = []): string[] {
  return checkUnit(parseUnit(text, name), deployFiles);
}

test('a service with no ExecStart fails', () => {
  const problems = fixtureProblems(
    'broken.service',
    '[Unit]\nDescription=broken\n\n[Service]\nType=simple\n\n[Install]\nWantedBy=multi-user.target\n',
  );
  assert.ok(problems.some((p) => p.includes('ExecStart')), `expected an ExecStart problem, got: ${problems}`);
});

test('a service with an unknown Type fails', () => {
  const problems = fixtureProblems(
    'broken.service',
    '[Unit]\nDescription=broken\n\n[Service]\nType=bogus\nExecStart=/usr/bin/node x.ts\n\n[Install]\nWantedBy=multi-user.target\n',
  );
  assert.ok(problems.some((p) => p.includes('Type=bogus')), `expected a Type problem, got: ${problems}`);
});

test('a service with a relative ExecStart fails', () => {
  const problems = fixtureProblems(
    'broken.service',
    '[Unit]\nDescription=broken\n\n[Service]\nExecStart=node scripts/x.ts\n\n[Install]\nWantedBy=multi-user.target\n',
  );
  assert.ok(problems.some((p) => p.includes('absolute path')), `expected a path problem, got: ${problems}`);
});

test('a service with no [Install] and no paired timer fails', () => {
  const problems = fixtureProblems(
    'lonely.service',
    '[Unit]\nDescription=lonely\n\n[Service]\nExecStart=/usr/bin/node x.ts\n',
    ['lonely.service'],
  );
  assert.ok(problems.some((p) => p.includes('WantedBy')), `expected a WantedBy problem, got: ${problems}`);
});

test('a timer with no OnCalendar fails', () => {
  const problems = fixtureProblems(
    'broken.timer',
    '[Unit]\nDescription=broken\n\n[Timer]\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n',
  );
  assert.ok(problems.some((p) => p.includes('OnCalendar')), `expected an OnCalendar problem, got: ${problems}`);
});

test('a timer pointing Unit= at nothing fails', () => {
  const problems = fixtureProblems(
    'broken.timer',
    '[Unit]\nDescription=broken\n\n[Timer]\nOnCalendar=*-*-* 04:17:00\nUnit=ghost.service\n\n[Install]\nWantedBy=timers.target\n',
    ['broken.timer'],
  );
  assert.ok(problems.some((p) => p.includes('ghost.service')), `expected a Unit= problem, got: ${problems}`);
});

test('a unit with content outside any section fails to parse', () => {
  assert.throws(() => parseUnit('ExecStart=/usr/bin/node x.ts\n', 'stray.service'), /outside any section/);
});

// ---------------------------------------------------------------------------
// TOG-5688 fixtures: each hardening rule must fail on a deliberately broken
// unit. Assertions name the rule, not just non-zero: a guard that fails for
// the wrong reason goes vacuous the same way.
// ---------------------------------------------------------------------------

const HARDENED_ONESHOT = [
  '[Unit]',
  'Description=hardened',
  '',
  '[Service]',
  'Type=oneshot',
  'ExecStart=/usr/bin/node scripts/x.ts',
  'NoNewPrivileges=true',
  'PrivateTmp=true',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'UMask=0077',
  'CapabilityBoundingSet=',
  'MemoryMax=512M',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
  '',
].join('\n');

const HARDENED_LONG_RUNNING = HARDENED_ONESHOT.replace('Type=oneshot', 'Type=simple')
  // The crash-loop cap lives in [Unit]: systemd 255+ ignores it in [Service].
  .replace('Description=hardened', 'Description=hardened\nStartLimitIntervalSec=300\nStartLimitBurst=10')
  .replace('MemoryMax=512M', 'Restart=always\nRestartSec=5\nMemoryMax=512M');

function hardeningProblems(name: string, text: string): string[] {
  return checkHardening(parseUnit(text, name));
}

test('a service missing the sandbox baseline fails', () => {
  const problems = hardeningProblems(
    'bare.service',
    '[Unit]\nDescription=bare\nStartLimitIntervalSec=300\nStartLimitBurst=10\n\n[Service]\nType=simple\nExecStart=/usr/bin/node x.ts\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n',
  );
  for (const key of ['NoNewPrivileges', 'ProtectSystem', 'CapabilityBoundingSet', 'MemoryMax']) {
    assert.ok(
      problems.some((p) => p.includes(key)),
      `expected a ${key} problem, got: ${problems}`,
    );
  }
});

test('a secret baked into Environment= fails', () => {
  const text = HARDENED_LONG_RUNNING.replace(
    'Restart=always',
    'Environment=DISCORD_TOKEN=live-value-that-must-never-be-here\nRestart=always',
  );
  const problems = hardeningProblems('leaky.service', text);
  assert.ok(
    problems.some((p) => p.includes('DISCORD_TOKEN') && p.includes('LoadCredential')),
    `expected a baked-secret problem, got: ${problems}`,
  );
});

test('a credential pointing outside /etc/two-bot/credentials/ fails', () => {
  const text = HARDENED_LONG_RUNNING.replace(
    'MemoryMax=512M',
    'LoadCredential=discord_token:/tmp/somewhere-else\nMemoryMax=512M',
  );
  const problems = hardeningProblems('stray-cred.service', text);
  assert.ok(
    problems.some((p) => p.includes('/etc/two-bot/credentials/')),
    `expected a credential-path problem, got: ${problems}`,
  );
});

test('a long-running service with no Restart= fails', () => {
  const text = HARDENED_LONG_RUNNING.replace('Restart=always\n', '');
  const problems = hardeningProblems('norestart.service', text);
  assert.ok(
    problems.some((p) => p.includes('Restart=always')),
    `expected a Restart problem, got: ${problems}`,
  );
});

test('a long-running service with no crash-loop cap fails', () => {
  const text = HARDENED_LONG_RUNNING.replace('StartLimitBurst=10\n', '');
  const problems = hardeningProblems('nocap.service', text);
  assert.ok(
    problems.some((p) => p.includes('StartLimitBurst')),
    `expected a crash-loop-cap problem, got: ${problems}`,
  );
});

test('a crash-loop cap in [Service] instead of [Unit] fails', () => {
  // TOG-9539: three units carried StartLimit* in [Service], which systemd
  // 255+ ignores - the cap was a comment and hosted CI caught it. Moving the
  // keys back under [Service] must fail here, not on a hosted runner.
  const text = HARDENED_LONG_RUNNING.replace(
    'StartLimitIntervalSec=300\nStartLimitBurst=10\n',
    '',
  ).replace('RestartSec=5\n', 'RestartSec=5\nStartLimitIntervalSec=300\nStartLimitBurst=10\n');
  const problems = hardeningProblems('misplaced-cap.service', text);
  assert.ok(
    problems.some((p) => p.includes('belongs in [Unit]')),
    `expected a misplaced-cap problem, got: ${problems}`,
  );
});

test('an oneshot with Restart= fails', () => {
  const text = HARDENED_ONESHOT.replace('MemoryMax=512M', 'Restart=always\nMemoryMax=512M');
  const problems = hardeningProblems('looping.service', text);
  assert.ok(
    problems.some((p) => p.includes('oneshot')),
    `expected an oneshot-restart problem, got: ${problems}`,
  );
});

test('fully hardened units pass', () => {
  assert.deepEqual(hardeningProblems('ok-long.service', HARDENED_LONG_RUNNING), []);
  assert.deepEqual(hardeningProblems('ok-oneshot.service', HARDENED_ONESHOT), []);
});

// ---------------------------------------------------------------------------
// docker-compose.yml: structural lint without a YAML dependency.
// ---------------------------------------------------------------------------

const COMPOSE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

function checkCompose(text: string): string[] {
  const problems: string[] = [];
  if (/\t/.test(text)) problems.push('compose file contains tabs - YAML forbids them');
  // A bad indent is the compose failure mode; every level here is 2 spaces.
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent % 2 !== 0) problems.push(`line ${i + 1}: indent ${indent} is not a multiple of 2: ${line.trim()}`);
  });

  // The bot must fail loud on a missing secret, never run against a default.
  for (const v of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'TWO_DATABASE_URL']) {
    if (!text.includes(`${v}: \${${v}:?`)) {
      problems.push(`${v} is not a required-without-default (\${${v}:?...}) variable`);
    }
  }
  // Nothing inbound: the bot dials out to Discord and Postgres, and Coolify
  // reaches health on the container network. A `ports:` mapping would put an
  // unauthenticated endpoint on the host.
  if (/^\s*ports:/m.test(text)) problems.push('a `ports:` mapping publishes a container port to the host');
  if (!/^\s*expose:\s*$/m.test(text)) problems.push('expected an `expose:` block and found none');
  if (!text.includes('/readyz')) problems.push('healthcheck does not probe /readyz');
  if (!text.includes('two-bot-data:/app/data')) problems.push('bot volume two-bot-data:/app/data is missing');
  if (!/^\s*two-bot-data:\s*$/m.test(text)) problems.push('named volume two-bot-data is not declared');
  if (!text.includes('dockerfile: Dockerfile')) problems.push('bot build does not point at Dockerfile');
  return problems;
}

test('docker-compose.yml is structurally valid', () => {
  const problems = checkCompose(COMPOSE);
  assert.deepEqual(problems, [], `docker-compose.yml problems:\n${problems.join('\n')}`);
});

test('compose lint catches a published port and a tab indent', () => {
  const withPorts = COMPOSE.replace('    expose:', '    ports:\n      - "8080:8080"\n    expose:');
  assert.ok(
    checkCompose(withPorts).some((p) => p.includes('ports:')),
    'a `ports:` mapping must be rejected',
  );
  assert.ok(
    checkCompose(`${COMPOSE}\tbad: true\n`).some((p) => p.includes('tabs')),
    'a tab indent must be rejected',
  );
});

test('compose lint catches a secret with a silent default', () => {
  const withDefault = COMPOSE.replace('${DISCORD_BOT_TOKEN:?', '${DISCORD_BOT_TOKEN:-');
  assert.ok(
    checkCompose(withDefault).some((p) => p.includes('DISCORD_BOT_TOKEN')),
    'a defaulted bot token must be rejected',
  );
});

// ---------------------------------------------------------------------------
// Dockerfile: hadolint-style basics, no linter binary needed.
// ---------------------------------------------------------------------------

const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

function checkDockerfile(text: string): string[] {
  const problems: string[] = [];
  // Comments document exactly the mistakes this lint forbids (`npm start`
  // would break SIGTERM, the token lives in env) - match instructions only.
  const code = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const from = code.match(/^FROM\s+(\S+)/m)?.[1];
  if (!from) problems.push('no FROM instruction');
  else if (!from.startsWith('node:24')) problems.push(`base image is not node:24, got: ${from}`);
  if (!/^USER node$/m.test(code)) problems.push('image never drops to USER node');
  else {
    // Dropping privileges only counts if it happens before the process starts.
    const userAt = code.search(/^USER node$/m);
    const cmdAt = code.search(/^CMD\b/m);
    if (cmdAt >= 0 && userAt > cmdAt) problems.push('USER node comes after CMD - the process runs as root');
  }
  if (/^CMD\s+npm\s+start/m.test(code)) {
    problems.push('CMD uses npm start - npm does not forward SIGTERM to the bot');
  }
  if (!/^HEALTHCHECK\b/m.test(code)) problems.push('no HEALTHCHECK instruction');
  else if (!code.includes('/healthz')) problems.push('HEALTHCHECK does not probe /healthz');
  if (/^ADD\s/m.test(code)) problems.push('ADD used - COPY is explicit and does not fetch URLs');
  if (/^USER root$/m.test(code)) problems.push('image switches back to USER root');
  if (/^EXPOSE\s+.*8787/m.test(code)) problems.push('port 8787 exposed - the actions endpoint must stay off the host');
  if (/^(ENV|ARG)\s+.*DISCORD.*TOKEN/m.test(code)) {
    problems.push('Dockerfile bakes a Discord token into ENV/ARG - secrets stay in env/credentials, never in layers');
  }
  if (!/COPY --chown=node:node/.test(code)) problems.push('no COPY --chown=node:node - files would land root-owned');
  return problems;
}

test('Dockerfile passes the lint basics', () => {
  const problems = checkDockerfile(DOCKERFILE);
  assert.deepEqual(problems, [], `Dockerfile problems:\n${problems.join('\n')}`);
});

test('Dockerfile lint catches npm start, root and a leaked token', () => {
  const withNpm = DOCKERFILE.replace('CMD ["node", "src/index.ts"]', 'CMD npm start');
  assert.ok(
    checkDockerfile(withNpm).some((p) => p.includes('npm start')),
    'CMD npm start must be rejected',
  );
  const asRoot = `${DOCKERFILE}\nUSER root\n`;
  assert.ok(
    checkDockerfile(asRoot).some((p) => p.includes('USER root')),
    'USER root must be rejected',
  );
  const withToken = DOCKERFILE.replace(/^ENV NODE_ENV=production \\$/m, 'ENV DISCORD_BOT_TOKEN=abc \\$');
  assert.ok(
    checkDockerfile(withToken).some((p) => p.includes('token')),
    'a token in the Dockerfile must be rejected',
  );
});

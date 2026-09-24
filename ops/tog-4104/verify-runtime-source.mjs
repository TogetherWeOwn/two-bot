#!/usr/bin/env node
// Offline provenance check. Fetch the documented exact Git object separately;
// this command never fetches, contacts a runtime, or substitutes a moving ref.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/tog4104-runtime-source.json', import.meta.url), 'utf8'));
assert.equal(fixture.revision, 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90');
for (const block of Object.values(fixture.blocks)) {
  const object = `${fixture.revision}:${block.path}`;
  const source = execFileSync('git', ['-C', root, 'show', object], { encoding: 'utf8' });
  const blob = execFileSync('git', ['-C', root, 'rev-parse', object], { encoding: 'utf8' }).trim();
  assert.equal(blob, block.blob);
  const excerpt = source.split('\n').slice(block.startLine - 1, block.endLine).join('\n') + '\n';
  assert.equal(excerpt, block.code, object);
  assert.equal(createHash('sha256').update(excerpt).digest('hex'), block.sha256);
}
console.log(`Verified ${Object.keys(fixture.blocks).length} exact source excerpts at ${fixture.revision}`);

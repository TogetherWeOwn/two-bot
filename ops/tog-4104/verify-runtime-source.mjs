#!/usr/bin/env node
// Verify the settings-wiring surface against the reviewed baseline object.
//
// Reads test/fixtures/tog4104-runtime-source.json: a baseline commit plus one
// entry per surface block (path, blob, line range, sha256, exact code). For
// each block it fetches the exact Git object `<baseline>:<path>` — never the
// moving checkout — and asserts the recorded blob ID, the excerpt text and
// its sha256. Any drift in the wiring surface fails here, before any host use.
//
// Usage: node ops/tog-4104/verify-runtime-source.mjs [baseline-override]
// The optional override lets the operator check a candidate runtime against
// the same reviewed excerpt text; it must still be blob-identical.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/tog4104-runtime-source.json', import.meta.url), 'utf8'));
let baseline = process.argv[2] ?? fixture.baseline;
// Resolve a caller-supplied ref to its commit, then require the full SHA form
// so no abbreviated or moving ref reaches the object fetches below.
baseline = execFileSync('git', ['-C', root, 'rev-parse', `${baseline}^{commit}`], { encoding: 'utf8' }).trim();
assert.match(baseline, /^[a-f0-9]{40}$/, 'baseline must resolve to a full commit SHA');
for (const [name, block] of Object.entries(fixture.blocks)) {
  const object = `${baseline}:${block.path}`;
  const source = execFileSync('git', ['-C', root, 'show', object], { encoding: 'utf8' });
  const blob = execFileSync('git', ['-C', root, 'rev-parse', object], { encoding: 'utf8' }).trim();
  assert.equal(blob, block.blob, `${name}: blob drift at ${baseline}`);
  const excerpt = source.split('\n').slice(block.startLine - 1, block.endLine).join('\n') + '\n';
  assert.equal(excerpt, block.code, `${name}: excerpt text drift at ${baseline}`);
  assert.equal(createHash('sha256').update(excerpt).digest('hex'), block.sha256, `${name}: sha256 drift`);
}
console.log(`Verified ${Object.keys(fixture.blocks).length} exact surface excerpts at ${baseline}`);

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf-8'));

it('keeps package.json and plugin.json versions in sync', () => {
  assert.equal(readJson('../plugin.json').version, readJson('../package.json').version);
});

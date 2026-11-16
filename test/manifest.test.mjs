import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf-8'));

it('keeps package.json and plugin.json versions in sync', () => {
  assert.equal(readJson('../plugin.json').version, readJson('../package.json').version);
});

it('ships valid plugin.json and production sidecar.json manifests', () => {
  const allowedPluginFields = new Set([
    'name',
    'displayName',
    'version',
    'description',
    'logo',
    'suggestedPrompts',
    'author',
    'homepage',
    'repository',
    'disabled',
  ]);
  const plugin = readJson('../plugin.json');
  for (const key of Object.keys(plugin)) {
    assert.ok(allowedPluginFields.has(key), `unexpected plugin.json field: ${key}`);
  }

  const sidecar = readJson('../sidecars/context-monitor/sidecar.json');
  assert.deepEqual(sidecar.args, ['server.mjs']);
  assert.equal(sidecar.agent_permissions?.allows_user_interactions, false);
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../install.mjs';

describe('Installer CLI (install.mjs)', () => {
  let tmpConfigDir;

  before(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'agy-cfg-test-'));
    // Seed existing config.json to verify preservation of sibling keys
    writeFileSync(
      join(tmpConfigDir, 'config.json'),
      JSON.stringify({ userSettings: { theme: 'dark' } }, null, 2)
    );
  });

  after(() => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('installs standalone sidecar, preserves existing config.json keys, and sets 0600 mode', async () => {
    const res = await runCli(['--standalone', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'standalone');

    const cfgPath = join(tmpConfigDir, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(cfg.userSettings.theme, 'dark');
    assert.equal(cfg.sidecars['context-monitor'].enabled, true);

    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') {
      assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
    }
  });

  it('copies the whole sidecar directory, including the UI files', async () => {
    const dir = join(tmpConfigDir, 'sidecars', 'context-monitor');
    for (const f of ['sidecar.json', 'server.mjs', 'metrics.mjs', 'pricing.mjs', 'ui/index.html', 'ui/preload.js']) {
      assert.ok(existsSync(join(dir, f)), `missing ${f}`);
    }
  });

  it('installs plugin bundle and switches sidecar enablement to avoid duplicate panels', async () => {
    const res = await runCli(['--plugin', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'plugin');

    const cfg = JSON.parse(readFileSync(join(tmpConfigDir, 'config.json'), 'utf-8'));
    assert.equal(cfg.plugins['context-monitor'].enabled, true);
    assert.equal(cfg.sidecars['context-monitor/context-monitor'].enabled, true);
    assert.equal(cfg.sidecars['context-monitor'].enabled, false);

    const st = await runCli(['--status', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(st.status.pluginInstalled, true);
    assert.equal(st.status.pluginSidecarEnabled, true);

    const un = await runCli(['--uninstall', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(un.ok, true);
  });

  it('aborts without touching config.json when it is not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cfg-bad-'));
    try {
      const cfgPath = join(dir, 'config.json');
      writeFileSync(cfgPath, '{ "userSettings": { "theme": "dark", }');
      const before = readFileSync(cfgPath, 'utf-8');
      await assert.rejects(runCli(['--standalone', '--config-dir', dir, '--quiet']), /not a valid JSON object/);
      writeFileSync(cfgPath, 'null');
      await assert.rejects(runCli(['--standalone', '--config-dir', dir, '--quiet']), /not a valid JSON object/);
      writeFileSync(cfgPath, before);
      assert.equal(readFileSync(cfgPath, 'utf-8'), before);
      assert.equal(existsSync(join(dir, 'sidecars')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown options instead of falling back to a default install', async () => {
    await assert.rejects(runCli(['--plugins', '--config-dir', tmpConfigDir]), /Unknown option: --plugins/);
  });

  it('activates, reports, and disables a plugin installed under another directory name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cfg-inplace-'));
    try {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
      const pluginDir = join(dir, 'plugins', 'agy-pulse');
      cpSync(join(repoRoot, 'install.mjs'), join(pluginDir, 'install.mjs'));
      const run = (...args) =>
        execFileSync(process.execPath, [join(pluginDir, 'install.mjs'), '--config-dir', dir, ...args], {
          encoding: 'utf-8',
        });
      const readCfg = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));

      run('--quiet');
      assert.equal(readCfg().sidecars['agy-pulse/context-monitor'].enabled, true);
      assert.match(run('--status'), /"pluginSidecarEnabled": true/);

      run('--uninstall', '--quiet');
      assert.equal(readCfg().sidecars['agy-pulse/context-monitor'].enabled, false);
      assert.ok(existsSync(join(pluginDir, 'install.mjs')), 'must not delete the directory it runs from');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only one registration enabled across plugin directories with different names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cfg-dup-'));
    try {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
      const otherDir = join(dir, 'plugins', 'agy-pulse');
      mkdirSync(otherDir, { recursive: true });
      cpSync(join(repoRoot, 'plugin.json'), join(otherDir, 'plugin.json'));
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ sidecars: { 'agy-pulse/context-monitor': { enabled: true } } })
      );
      const readCfg = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));

      await runCli(['--plugin', '--config-dir', dir, '--quiet']);
      assert.equal(readCfg().sidecars['agy-pulse/context-monitor'].enabled, false);
      assert.equal(readCfg().sidecars['context-monitor/context-monitor'].enabled, true);

      rmSync(join(dir, 'plugins', 'context-monitor'), { recursive: true, force: true });
      const before = await runCli(['--status', '--config-dir', dir, '--quiet']);
      assert.equal(before.status.pluginInstalled, true, 'plugin under plugins/agy-pulse counts as installed');

      await runCli(['--uninstall', '--config-dir', dir, '--quiet']);
      const st = await runCli(['--status', '--config-dir', dir, '--quiet']);
      assert.equal(st.status.pluginSidecarEnabled, false);
      assert.equal(st.status.standaloneEnabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes through a symlinked config.json instead of replacing the link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cfg-link-'));
    try {
      const realCfg = join(dir, 'dotfiles-config.json');
      writeFileSync(realCfg, JSON.stringify({ userSettings: { theme: 'dark' } }));
      const cfgDir = join(dir, 'config');
      mkdirSync(cfgDir);
      symlinkSync(realCfg, join(cfgDir, 'config.json'));

      await runCli(['--standalone', '--config-dir', cfgDir, '--quiet']);
      assert.ok(lstatSync(join(cfgDir, 'config.json')).isSymbolicLink());
      const cfg = JSON.parse(readFileSync(realCfg, 'utf-8'));
      assert.equal(cfg.userSettings.theme, 'dark');
      assert.equal(cfg.sidecars['context-monitor'].enabled, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

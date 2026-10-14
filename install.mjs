#!/usr/bin/env node
/**
 * Antigravity Context & TPS Monitor — Zero-Dependency Installer & Lifecycle CLI
 *
 * Supports:
 *   node install.mjs                 # Install/update standalone sidecar (or activate plugin if run inside plugins/<dir>)
 *   node install.mjs --standalone    # Install standalone global sidecar at ~/.gemini/config/sidecars/context-monitor
 *   node install.mjs --plugin        # Install full plugin bundle at ~/.gemini/config/plugins/context-monitor
 *   node install.mjs --status        # Show current installation & config.json enablement status
 *   node install.mjs --uninstall     # Disable sidecar entries and remove installed files
 *   node install.mjs --config-dir X  # Override ~/.gemini/config path (used for testing)
 */

import {
  chmodSync,
   copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv) {
  const opts = {
    mode: 'auto', // 'auto' | 'standalone' | 'plugin' | 'status' | 'uninstall'
    configDir: process.env.AGY_CONFIG_DIR || join(homedir(), '.gemini', 'config'),
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--standalone') opts.mode = 'standalone';
    else if (a === '--plugin') opts.mode = 'plugin';
    else if (a === '--status') opts.mode = 'status';
    else if (a === '--uninstall' || a === 'uninstall') opts.mode = 'uninstall';
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--config-dir' && argv[i + 1]) {
      opts.configDir = resolve(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      opts.mode = 'help';
    }
  }
  return opts;
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfigAtomic(configPath, data) {
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  copyFileSync(tmpPath, configPath);
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // ignore
  }
  rmSync(tmpPath, { force: true });
}

async function tryNotifyLanguageServer(patch) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/JetboxWriteState`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: JSON.stringify({ userConfig: patch }),
        signal: controller.signal,
      }
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function detectContainingPluginDir(configDir) {
  const pluginsRoot = resolve(configDir, 'plugins');
  const selfDir = resolve(__dirname);
  if (selfDir.startsWith(pluginsRoot + '/')) {
    const rel = selfDir.slice(pluginsRoot.length + 1);
    const seg = rel.split('/')[0];
    if (seg) return seg;
  }
  return null;
}

export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const log = (...args) => {
    if (!opts.quiet) console.log(...args);
  };

  if (opts.mode === 'help') {
    log(`Usage: npx antigravity-context-monitor [options]

Options:
  --standalone       Install standalone sidecar to ~/.gemini/config/sidecars/context-monitor (default)
  --plugin           Install full plugin bundle to ~/.gemini/config/plugins/context-monitor
  --status           Inspect current installation and config.json state
  --uninstall        Disable sidecar and remove installed files
  --config-dir <p>   Override target ~/.gemini/config directory
`);
    return { ok: true, mode: 'help' };
  }

  const configPath = join(opts.configDir, 'config.json');
  const standaloneDir = join(opts.configDir, 'sidecars', 'context-monitor');
  const pluginInstallDir = join(opts.configDir, 'plugins', 'context-monitor');

  if (opts.mode === 'status') {
    const cfg = readJsonSafe(configPath);
    const standaloneFiles = existsSync(join(standaloneDir, 'server.mjs'));
    const pluginFiles = existsSync(join(pluginInstallDir, 'plugin.json'));
    const standaloneEnabled = Boolean(cfg?.sidecars?.['context-monitor']?.enabled);
    const pluginSidecarEnabled = Boolean(
      cfg?.sidecars?.['context-monitor/context-monitor']?.enabled
    );
    const status = {
      configPath,
      standaloneInstalled: standaloneFiles,
      standaloneEnabled,
      pluginInstalled: pluginFiles,
      pluginSidecarEnabled,
    };
    log('[context-monitor] Status:', JSON.stringify(status, null, 2));
    return { ok: true, mode: 'status', status };
  }

  if (opts.mode === 'uninstall') {
    const cfg = readJsonSafe(configPath);
    cfg.sidecars = cfg.sidecars || {};
    if (cfg.sidecars['context-monitor']) {
      cfg.sidecars['context-monitor'].enabled = false;
    }
    if (cfg.sidecars['context-monitor/context-monitor']) {
      cfg.sidecars['context-monitor/context-monitor'].enabled = false;
    }
    writeConfigAtomic(configPath, cfg);
    await tryNotifyLanguageServer({ sidecars: cfg.sidecars });

    if (existsSync(standaloneDir)) {
      rmSync(standaloneDir, { recursive: true, force: true });
    }
    if (existsSync(pluginInstallDir) && resolve(__dirname) !== resolve(pluginInstallDir)) {
      rmSync(pluginInstallDir, { recursive: true, force: true });
    }
    log('[context-monitor] Uninstalled and disabled in config.json.');
    return { ok: true, mode: 'uninstall' };
  }

  // Determine effective install mode
  const containingPluginDir = detectContainingPluginDir(opts.configDir);
  let targetMode = opts.mode;
  if (targetMode === 'auto') {
    targetMode = containingPluginDir ? 'in-place-plugin' : 'standalone';
  }

  const srcSidecarDir = join(__dirname, 'sidecars', 'context-monitor');
  const cfg = readJsonSafe(configPath);
  cfg.sidecars = cfg.sidecars || {};
  cfg.plugins = cfg.plugins || {};

  if (targetMode === 'in-place-plugin') {
    const sidecarKey = `${containingPluginDir}/context-monitor`;
    cfg.plugins[containingPluginDir] = { ...(cfg.plugins[containingPluginDir] || {}), enabled: true };
    cfg.sidecars[sidecarKey] = { ...(cfg.sidecars[sidecarKey] || {}), enabled: true };
    if (cfg.sidecars['context-monitor']) {
      cfg.sidecars['context-monitor'].enabled = false;
    }
    writeConfigAtomic(configPath, cfg);
    await tryNotifyLanguageServer({ plugins: cfg.plugins, sidecars: cfg.sidecars });
    log(`[context-monitor] Activated plugin sidecar: ${sidecarKey}`);
    return { ok: true, mode: 'in-place-plugin', sidecarId: sidecarKey };
  }

  if (targetMode === 'plugin') {
    mkdirSync(pluginInstallDir, { recursive: true });
    const itemsToCopy = [
      'plugin.json',
      'package.json',
      'install.mjs',
      'assets',
      'sidecars',
      'skills',
      'README.md',
      'README_CN.md',
      'LICENSE',
    ];
    for (const item of itemsToCopy) {
      const src = join(__dirname, item);
      const dst = join(pluginInstallDir, item);
      if (existsSync(src) && resolve(src) !== resolve(dst)) {
        cpSync(src, dst, { recursive: true, force: true });
      }
    }
    cfg.plugins['context-monitor'] = { ...(cfg.plugins['context-monitor'] || {}), enabled: true };
    cfg.sidecars['context-monitor/context-monitor'] = {
      ...(cfg.sidecars['context-monitor/context-monitor'] || {}),
      enabled: true,
    };
    if (cfg.sidecars['context-monitor']) {
      cfg.sidecars['context-monitor'].enabled = false;
    }
    writeConfigAtomic(configPath, cfg);
    await tryNotifyLanguageServer({ plugins: cfg.plugins, sidecars: cfg.sidecars });
    log(`[context-monitor] Installed plugin bundle to ${pluginInstallDir}`);
    log(`[context-monitor] Enabled sidecar: context-monitor/context-monitor`);
    return {
      ok: true,
      mode: 'plugin',
      installDir: pluginInstallDir,
      sidecarId: 'context-monitor/context-monitor',
    };
  }

  // Default: 'standalone' mode -> ~/.gemini/config/sidecars/context-monitor
  mkdirSync(standaloneDir, { recursive: true });
  copyFileSync(join(srcSidecarDir, 'sidecar.json'), join(standaloneDir, 'sidecar.json'));
  copyFileSync(join(srcSidecarDir, 'server.mjs'), join(standaloneDir, 'server.mjs'));
  try {
    chmodSync(join(standaloneDir, 'server.mjs'), 0o755);
  } catch {
    // ignore
  }

  cfg.sidecars['context-monitor'] = { ...(cfg.sidecars['context-monitor'] || {}), enabled: true };
  if (cfg.sidecars['context-monitor/context-monitor']) {
    cfg.sidecars['context-monitor/context-monitor'].enabled = false;
  }
  writeConfigAtomic(configPath, cfg);
  await tryNotifyLanguageServer({ sidecars: cfg.sidecars });

  log(`[context-monitor] Installed standalone sidecar to ${standaloneDir}`);
  log(`[context-monitor] Enabled sidecars["context-monitor"] in ${configPath}`);
  return {
    ok: true,
    mode: 'standalone',
    installDir: standaloneDir,
    sidecarId: 'context-monitor',
  };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli().catch((err) => {
    console.error('[context-monitor] Installation failed:', err);
    process.exit(1);
  });
}

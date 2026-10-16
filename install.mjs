#!/usr/bin/env node
/**
 * agy-pulse installer: deploys the Context & TPS sidecar + CLI statusLine and
 * toggles them in ~/.gemini/config/config.json and ~/.gemini/antigravity-cli/settings.json.
 * Zero dependencies.
 *
 * Supports:
 *   node install.mjs                   # Install/update standalone sidecar + CLI statusLine (or activate plugin in-place)
 *   node install.mjs --standalone      # Install standalone global sidecar at ~/.gemini/config/sidecars/context-monitor
 *   node install.mjs --plugin          # Install full plugin bundle at ~/.gemini/config/plugins/context-monitor
 *   node install.mjs --status          # Show current installation, config.json, and CLI statusLine status
 *   node install.mjs --uninstall       # Disable sidecar + CLI statusLine entries and remove installed files
 *   node install.mjs --config-dir X    # Override ~/.gemini/config path (used for testing)
 *   node install.mjs --cli-settings X  # Override ~/.gemini/antigravity-cli/settings.json path
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_GEMINI_ROOT = join(homedir(), '.gemini');
const DEFAULT_CONFIG_DIR = join(DEFAULT_GEMINI_ROOT, 'config');
const DEFAULT_CLI_SETTINGS_PATH = join(DEFAULT_GEMINI_ROOT, 'antigravity-cli', 'settings.json');

function parseArgs(argv) {
  let configDirOverridden = Boolean(process.env.AGY_CONFIG_DIR);
  const opts = {
    mode: 'auto', // 'auto' | 'standalone' | 'plugin' | 'status' | 'uninstall'
    configDir: process.env.AGY_CONFIG_DIR || DEFAULT_CONFIG_DIR,
    cliSettingsPath: process.env.AGY_CLI_SETTINGS_PATH
      ? resolve(process.env.AGY_CLI_SETTINGS_PATH)
      : null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--standalone') opts.mode = 'standalone';
    else if (a === '--plugin') opts.mode = 'plugin';
    else if (a === '--status') opts.mode = 'status';
    else if (a === '--uninstall' || a === 'uninstall') opts.mode = 'uninstall';
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--config-dir') {
      if (!argv[i + 1]) throw new Error('--config-dir requires a path.');
      opts.configDir = resolve(argv[++i]);
      configDirOverridden = true;
    } else if (a === '--cli-settings') {
      if (!argv[i + 1]) throw new Error('--cli-settings requires a path.');
      opts.cliSettingsPath = resolve(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      opts.mode = 'help';
    } else {
      throw new Error(`Unknown option: ${a}. Run with --help for usage.`);
    }
  }
  if (!opts.cliSettingsPath && !configDirOverridden) {
    opts.cliSettingsPath = DEFAULT_CLI_SETTINGS_PATH;
  }
  return opts;
}

// A missing config.json starts empty. An unreadable one aborts the run, so the
// installer never overwrites settings it could not parse.
function readConfig(configPath) {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf-8');
  try {
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg;
    throw new Error('top level is not an object');
  } catch (err) {
    throw new Error(`${configPath} is not a valid JSON object (${err.message}). Fix it, then rerun.`);
  }
}

function writeConfigAtomic(configPath, data) {
  mkdirSync(dirname(configPath), { recursive: true });
  // Write through a symlinked config.json (dotfile managers) instead of replacing the link.
  const targetPath = existsSync(configPath) ? realpathSync(configPath) : configPath;
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  renameSync(tmpPath, targetPath);
}

async function tryNotifyLanguageServer(patch, configDir) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return false;
  if (realPath(configDir) !== realPath(DEFAULT_CONFIG_DIR)) return false;
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

// Compare paths after resolving symlinks (macOS /var -> /private/var, symlinked ~/.gemini).
function realPath(p) {
  return existsSync(p) ? realpathSync(p) : resolve(p);
}

function detectContainingPluginDir(configDir) {
  const rel = relative(realPath(join(configDir, 'plugins')), realPath(__dirname));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep)[0];
}

// Every config key under which this sidecar can be registered: the standalone
// sidecar, and one per plugin directory holding this plugin, whatever its name
// (`--plugin` uses `context-monitor`; `agy plugin install` may pick another).
function sidecarKeys(configDir, containingPluginDir) {
  const pluginsRoot = join(configDir, 'plugins');
  const pluginDirs = new Set(['context-monitor']);
  if (containingPluginDir) pluginDirs.add(containingPluginDir);
  if (existsSync(pluginsRoot)) {
    for (const d of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(pluginsRoot, d.name, 'plugin.json'), 'utf-8'));
        if (manifest?.name === 'context-monitor') pluginDirs.add(d.name);
      } catch {
        // not a plugin, or not ours
      }
    }
  }
  return ['context-monitor', ...[...pluginDirs].map((d) => `${d}/context-monitor`)];
}

// Enable `key` and disable every other registration, so only one panel shows.
function enableOnly(cfg, key, keys) {
  for (const k of keys) {
    if (k !== key && cfg.sidecars[k]) cfg.sidecars[k].enabled = false;
  }
  cfg.sidecars[key] = { ...(cfg.sidecars[key] || {}), enabled: true };
}

function formatStatusLineCommand(scriptPath) {
  return /\s/.test(scriptPath) ? `node "${scriptPath}"` : `node ${scriptPath}`;
}

function isManagedStatusLine(statusLine) {
  if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine)) return false;
  const cmd = String(statusLine.command || '');
  return cmd.includes('context-monitor') && cmd.includes('statusline.mjs');
}

function setManagedStatusLine(cliCfg, scriptPath) {
  const prev =
    cliCfg.statusLine && typeof cliCfg.statusLine === 'object' && !Array.isArray(cliCfg.statusLine)
      ? cliCfg.statusLine
      : {};
  cliCfg.statusLine = {
    ...prev,
    type: 'command',
    command: formatStatusLineCommand(scriptPath),
    enabled: true,
    stack_with_default:
      typeof prev.stack_with_default === 'boolean' ? prev.stack_with_default : true,
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const log = (...args) => {
    if (!opts.quiet) console.log(...args);
  };

  if (opts.mode === 'help') {
    log(`Usage: node install.mjs [options]

Options:
  --standalone        Install standalone sidecar to ~/.gemini/config/sidecars/context-monitor (default)
  --plugin            Install full plugin bundle to ~/.gemini/config/plugins/context-monitor
  --status            Inspect current installation, config.json, and CLI statusLine state
  --uninstall         Disable sidecar + CLI statusLine and remove installed files
  --config-dir <p>    Override target ~/.gemini/config directory
  --cli-settings <p>  Override target ~/.gemini/antigravity-cli/settings.json file
`);
    return { ok: true, mode: 'help' };
  }

  const configPath = join(opts.configDir, 'config.json');
  const standaloneDir = join(opts.configDir, 'sidecars', 'context-monitor');
  const pluginInstallDir = join(opts.configDir, 'plugins', 'context-monitor');
  const containingPluginDir = detectContainingPluginDir(opts.configDir);
  const keys = sidecarKeys(opts.configDir, containingPluginDir);

  if (opts.mode === 'status') {
    const cfg = readConfig(configPath);
    const cliCfg = opts.cliSettingsPath ? readConfig(opts.cliSettingsPath) : null;
    const standaloneFiles = existsSync(join(standaloneDir, 'server.mjs'));
    const pluginFiles = keys
      .filter((k) => k !== 'context-monitor')
      .some((k) => existsSync(join(opts.configDir, 'plugins', k.split('/')[0], 'plugin.json')));
    const standaloneEnabled = Boolean(cfg?.sidecars?.['context-monitor']?.enabled);
    const pluginSidecarEnabled = keys
      .filter((k) => k !== 'context-monitor')
      .some((k) => Boolean(cfg?.sidecars?.[k]?.enabled));
    const statusLineEnabled = Boolean(
      cliCfg?.statusLine?.enabled && isManagedStatusLine(cliCfg.statusLine)
    );
    const status = {
      configPath,
      ...(opts.cliSettingsPath ? { cliSettingsPath: opts.cliSettingsPath } : {}),
      standaloneInstalled: standaloneFiles,
      standaloneEnabled,
      pluginInstalled: pluginFiles,
      pluginSidecarEnabled,
      statusLineEnabled,
    };
    log('[context-monitor] Status:', JSON.stringify(status, null, 2));
    return { ok: true, mode: 'status', status };
  }

  if (opts.mode === 'uninstall') {
    const cfg = readConfig(configPath);
    const cliCfg =
      opts.cliSettingsPath && existsSync(opts.cliSettingsPath)
        ? readConfig(opts.cliSettingsPath)
        : null;
    cfg.sidecars = cfg.sidecars || {};
    for (const key of keys) {
      if (cfg.sidecars[key]) cfg.sidecars[key].enabled = false;
    }
    writeConfigAtomic(configPath, cfg);
    if (cliCfg && isManagedStatusLine(cliCfg.statusLine)) {
      delete cliCfg.statusLine;
      writeConfigAtomic(opts.cliSettingsPath, cliCfg);
    }
    await tryNotifyLanguageServer({ sidecars: cfg.sidecars }, opts.configDir);

    if (existsSync(standaloneDir)) {
      rmSync(standaloneDir, { recursive: true, force: true });
    }
    if (existsSync(pluginInstallDir) && realPath(__dirname) !== realPath(pluginInstallDir)) {
      rmSync(pluginInstallDir, { recursive: true, force: true });
    }
    log('[context-monitor] Uninstalled and disabled in config.json.');
    return { ok: true, mode: 'uninstall' };
  }

  // Determine effective install mode
  let targetMode = opts.mode;
  if (targetMode === 'auto') {
    targetMode = containingPluginDir ? 'in-place-plugin' : 'standalone';
  }

  const srcSidecarDir = join(__dirname, 'sidecars', 'context-monitor');
  const cfg = readConfig(configPath);
  const cliCfg = opts.cliSettingsPath ? readConfig(opts.cliSettingsPath) : null;
  cfg.sidecars = cfg.sidecars || {};
  cfg.plugins = cfg.plugins || {};

  if (targetMode === 'in-place-plugin') {
    const sidecarKey = `${containingPluginDir}/context-monitor`;
    const statuslineScriptPath = join(
      opts.configDir,
      'plugins',
      containingPluginDir,
      'sidecars',
      'context-monitor',
      'statusline.mjs'
    );
    cfg.plugins[containingPluginDir] = { ...(cfg.plugins[containingPluginDir] || {}), enabled: true };
    enableOnly(cfg, sidecarKey, keys);
    writeConfigAtomic(configPath, cfg);
    if (cliCfg) {
      setManagedStatusLine(cliCfg, statuslineScriptPath);
      writeConfigAtomic(opts.cliSettingsPath, cliCfg);
    }
    await tryNotifyLanguageServer({ plugins: cfg.plugins, sidecars: cfg.sidecars }, opts.configDir);
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
      'docs',
      'sidecars',
      'skills',
      'README.md',
      'README_CN.md',
      'LICENSE',
    ];
    for (const item of itemsToCopy) {
      const src = join(__dirname, item);
      const dst = join(pluginInstallDir, item);
      if (existsSync(src) && realPath(src) !== realPath(dst)) {
        cpSync(src, dst, { recursive: true, force: true });
      }
    }
    const statuslineScriptPath = join(
      pluginInstallDir,
      'sidecars',
      'context-monitor',
      'statusline.mjs'
    );
    cfg.plugins['context-monitor'] = { ...(cfg.plugins['context-monitor'] || {}), enabled: true };
    enableOnly(cfg, 'context-monitor/context-monitor', keys);
    writeConfigAtomic(configPath, cfg);
    if (cliCfg) {
      setManagedStatusLine(cliCfg, statuslineScriptPath);
      writeConfigAtomic(opts.cliSettingsPath, cliCfg);
    }
    await tryNotifyLanguageServer({ plugins: cfg.plugins, sidecars: cfg.sidecars }, opts.configDir);
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
  cpSync(srcSidecarDir, standaloneDir, { recursive: true, force: true });

  const statuslineScriptPath = join(standaloneDir, 'statusline.mjs');
  enableOnly(cfg, 'context-monitor', keys);
  writeConfigAtomic(configPath, cfg);
  if (cliCfg) {
    setManagedStatusLine(cliCfg, statuslineScriptPath);
    writeConfigAtomic(opts.cliSettingsPath, cliCfg);
  }
  await tryNotifyLanguageServer({ sidecars: cfg.sidecars }, opts.configDir);

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
  process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  runCli().catch((err) => {
    console.error(`[context-monitor] Failed: ${err.message}`);
    process.exit(1);
  });
}

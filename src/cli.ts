/**
 * CLI — subcommand router for agentauth.
 *
 * Commands:
 *   agentauth init     Generate config from detected API keys
 *   agentauth start    Start proxy as background daemon
 *   agentauth stop     Stop running proxy daemon
 *   agentauth status   Show proxy health and running state
 *   agentauth doctor   Check for exposed secrets in environment
 *   agentauth run      Start proxy in foreground (default, legacy behavior)
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import http from 'http';

/** Default paths */
const DEFAULT_CONFIG = 'agentauth.json';
const DEFAULT_PID_FILE = '.agentauth.pid';
const DEFAULT_LOG_FILE = 'agentauth.log';
const LAUNCHD_PLIST_DIR = path.join(process.env.HOME || '~', 'Library', 'LaunchAgents');
const LAUNCHD_LABEL = 'com.agentauth.proxy';

/** Known secret env var patterns */
const SECRET_PATTERNS = [
  /^ANTHROPIC_API_KEY$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^OPENAI_API_KEY$/,
  /^GITHUB_TOKEN/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^GOOGLE_API_KEY$/,
];

export interface CliOptions {
  configPath: string;
  pidFile: string;
  logFile: string;
  port?: number;
  bind?: string;
  install?: boolean;
}

function parseCliOptions(args: string[]): CliOptions {
  const opts: CliOptions = {
    configPath: DEFAULT_CONFIG,
    pidFile: DEFAULT_PID_FILE,
    logFile: DEFAULT_LOG_FILE,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
      case '-c':
        opts.configPath = args[++i];
        break;
      case '--pid-file':
        opts.pidFile = args[++i];
        break;
      case '--log-file':
        opts.logFile = args[++i];
        break;
      case '--port':
      case '-p':
        opts.port = parseInt(args[++i]);
        break;
      case '--bind':
      case '-b':
        opts.bind = args[++i];
        break;
      case '--install':
        opts.install = true;
        break;
      default:
        // Positional arg = config path (legacy compat)
        if (!args[i].startsWith('-')) {
          opts.configPath = args[i];
        }
        break;
    }
  }

  return opts;
}

// ─── init ──────────────────────────────────────────────────────────────────

export async function cmdInit(args: string[]): Promise<void> {
  const opts = parseCliOptions(args);
  const configPath = path.resolve(opts.configPath);

  if (fs.existsSync(configPath)) {
    console.error(`Config already exists: ${configPath}`);
    console.error('Remove it first or use a different path with --config.');
    process.exit(1);
  }

  // Detect available API keys
  const detected: Record<string, { target: string; headerKey: string; envVar: string; paths: string[] }> = {};

  if (process.env.ANTHROPIC_API_KEY) {
    detected.anthropic = {
      target: 'https://api.anthropic.com',
      headerKey: 'x-api-key',
      envVar: 'ANTHROPIC_API_KEY',
      paths: ['/v1/messages'],
    };
  }

  if (process.env.OPENAI_API_KEY) {
    detected.openai = {
      target: 'https://api.openai.com',
      headerKey: 'authorization',
      envVar: 'OPENAI_API_KEY',
      paths: ['/v1/*'],
    };
  }

  if (process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN_BEARER) {
    const envVar = process.env.GITHUB_TOKEN_BEARER ? 'GITHUB_TOKEN_BEARER' : 'GITHUB_TOKEN';
    detected.github = {
      target: 'https://api.github.com',
      headerKey: 'authorization',
      envVar,
      paths: ['/repos/*'],
    };
  }

  if (Object.keys(detected).length === 0) {
    console.log('No API keys detected in environment.');
    console.log('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN and re-run.');
    console.log('\nGenerating config with anthropic placeholder...');
  }

  // Build config
  const backends: Record<string, unknown> = {};
  if (Object.keys(detected).length === 0) {
    // Placeholder config
    backends.anthropic = {
      target: 'https://api.anthropic.com',
      headers: { 'x-api-key': '$ANTHROPIC_API_KEY', 'anthropic-version': '2023-06-01' },
      allowedPaths: ['/v1/messages'],
    };
  } else {
    for (const [name, info] of Object.entries(detected)) {
      const headers: Record<string, string> = {};
      if (name === 'openai') {
        headers[info.headerKey] = `Bearer $${info.envVar}`;
      } else if (name === 'github') {
        headers[info.headerKey] = `Bearer $${info.envVar}`;
        headers['accept'] = 'application/vnd.github+json';
      } else {
        headers[info.headerKey] = `$${info.envVar}`;
      }

      if (name === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }

      backends[name] = {
        target: info.target,
        headers,
        allowedPaths: info.paths,
      };
    }
  }

  const config = {
    port: 9999,
    bind: '127.0.0.1',
    auditLog: './audit.log',
    backends,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`Created ${configPath}`);
  if (Object.keys(detected).length > 0) {
    console.log(`Detected backends: ${Object.keys(detected).join(', ')}`);
  }
  console.log('\nNext: agentauth start');
}

// ─── start ─────────────────────────────────────────────────────────────────

export async function cmdStart(args: string[]): Promise<void> {
  const opts = parseCliOptions(args);
  const configPath = path.resolve(opts.configPath);
  const pidFile = path.resolve(opts.pidFile);
  const logFile = path.resolve(opts.logFile);

  // Check config exists
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error('Run "agentauth init" first.');
    process.exit(1);
  }

  // Check not already running
  if (fs.existsSync(pidFile)) {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    if (isProcessRunning(existingPid)) {
      console.error(`agentauth already running (PID ${existingPid})`);
      console.error('Use "agentauth stop" first, or "agentauth status" to check.');
      process.exit(1);
    }
    // Stale PID file
    fs.unlinkSync(pidFile);
  }

  // Find the built index.js
  const indexPath = findIndexJs();

  // Build daemon args
  const daemonArgs = [indexPath, configPath];
  if (opts.port) daemonArgs.push('--port', String(opts.port));
  if (opts.bind) daemonArgs.push('--bind', opts.bind);

  // Spawn detached daemon
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });

  child.unref();
  fs.closeSync(logFd);

  // Write PID file
  if (child.pid) {
    fs.writeFileSync(pidFile, String(child.pid) + '\n');
  }

  console.log(`agentauth started (PID ${child.pid})`);
  console.log(`Config: ${configPath}`);
  console.log(`Log:    ${logFile}`);
  console.log(`PID:    ${pidFile}`);

  // Wait a moment and verify it's actually running
  await sleep(500);
  if (child.pid && !isProcessRunning(child.pid)) {
    console.error('\nProxy failed to start. Check the log:');
    console.error(`  tail ${logFile}`);
    fs.unlinkSync(pidFile);
    process.exit(1);
  }

  // Install LaunchAgent if requested
  if (opts.install && process.platform === 'darwin') {
    installLaunchAgent(configPath, logFile);
  }
}

// ─── stop ──────────────────────────────────────────────────────────────────

export async function cmdStop(args: string[]): Promise<void> {
  const opts = parseCliOptions(args);
  const pidFile = path.resolve(opts.pidFile);

  if (!fs.existsSync(pidFile)) {
    console.log('agentauth is not running (no PID file found).');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());

  if (!isProcessRunning(pid)) {
    console.log(`agentauth is not running (stale PID ${pid}).`);
    fs.unlinkSync(pidFile);
    return;
  }

  // Graceful shutdown
  process.kill(pid, 'SIGTERM');
  console.log(`Sent SIGTERM to PID ${pid}`);

  // Wait for process to exit
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!isProcessRunning(pid)) {
      fs.unlinkSync(pidFile);
      console.log('agentauth stopped.');
      return;
    }
  }

  // Force kill
  console.log('Process did not exit gracefully, sending SIGKILL...');
  process.kill(pid, 'SIGKILL');
  await sleep(500);
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  console.log('agentauth killed.');
}

// ─── status ────────────────────────────────────────────────────────────────

export async function cmdStatus(args: string[]): Promise<void> {
  const opts = parseCliOptions(args);
  const pidFile = path.resolve(opts.pidFile);

  // Check PID
  let pid: number | null = null;
  let running = false;
  if (fs.existsSync(pidFile)) {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    running = isProcessRunning(pid);
  }

  if (!running) {
    console.log('agentauth: not running');
    if (pid) {
      console.log(`  (stale PID file for ${pid})`);
    }
    return;
  }

  console.log(`agentauth: running (PID ${pid})`);

  // Try health endpoint
  const port = opts.port || 9999;
  const bind = opts.bind || '127.0.0.1';
  try {
    const health = await httpGet(`http://${bind}:${port}/agentauth/health`);
    const data = JSON.parse(health);
    console.log(`  Status:   ${data.status}`);
    console.log(`  Port:     ${data.port}`);
    console.log(`  Backends: ${data.backends.join(', ')}`);
  } catch {
    console.log('  Health endpoint unreachable');
  }
}

// ─── doctor ────────────────────────────────────────────────────────────────

export async function cmdDoctor(_args: string[]): Promise<void> {
  let issues = 0;

  console.log('agentauth doctor\n');

  // 1. Check for exposed secrets
  console.log('Checking environment for exposed secrets...');
  for (const pattern of SECRET_PATTERNS) {
    for (const [key, value] of Object.entries(process.env)) {
      if (pattern.test(key) && value) {
        console.log(`  EXPOSED: ${key} is set (${value.length} chars)`);
        issues++;
      }
    }
  }
  if (issues === 0) {
    console.log('  OK: No secrets found in environment');
  }

  // 2. Check if proxy is running
  console.log('\nChecking proxy status...');
  try {
    const health = await httpGet('http://127.0.0.1:9999/agentauth/health');
    const data = JSON.parse(health);
    console.log(`  OK: Proxy running on port ${data.port} with backends: ${data.backends.join(', ')}`);
  } catch {
    console.log('  NOT RUNNING: Proxy not reachable on localhost:9999');
    issues++;
  }

  // 3. Check if config exists
  console.log('\nChecking configuration...');
  if (fs.existsSync(DEFAULT_CONFIG)) {
    console.log(`  OK: ${DEFAULT_CONFIG} exists`);
  } else if (fs.existsSync('agentauth.json')) {
    console.log('  OK: agentauth.json exists');
  } else {
    console.log('  MISSING: No agentauth.json found');
    issues++;
  }

  // 4. Check ANTHROPIC_BASE_URL points to proxy
  console.log('\nChecking agent configuration...');
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl && baseUrl.includes('localhost') && baseUrl.includes('9999')) {
    console.log(`  OK: ANTHROPIC_BASE_URL points to proxy (${baseUrl})`);
  } else if (baseUrl) {
    console.log(`  WARN: ANTHROPIC_BASE_URL set but not pointing to proxy: ${baseUrl}`);
    issues++;
  } else {
    console.log('  MISSING: ANTHROPIC_BASE_URL not set (agents will use direct API access)');
    issues++;
  }

  // 5. Check LaunchAgent on macOS
  if (process.platform === 'darwin') {
    console.log('\nChecking LaunchAgent...');
    const plistPath = path.join(LAUNCHD_PLIST_DIR, `${LAUNCHD_LABEL}.plist`);
    if (fs.existsSync(plistPath)) {
      console.log(`  OK: LaunchAgent installed at ${plistPath}`);
    } else {
      console.log('  INFO: No LaunchAgent installed (proxy won\'t auto-start on login)');
      console.log('        Install with: agentauth start --install');
    }
  }

  // Summary
  console.log(`\n${issues === 0 ? 'All checks passed.' : `${issues} issue(s) found.`}`);
  process.exit(issues > 0 ? 1 : 0);
}

// ─── help ──────────────────────────────────────────────────────────────────

export function showHelp(): void {
  console.log(`agentauth — localhost HTTP proxy for secret injection

Usage:
  agentauth <command> [options]
  agentauth [config.json]          Start proxy in foreground (legacy)

Commands:
  init      Generate config from detected API keys
  start     Start proxy as background daemon
  stop      Stop running proxy daemon
  status    Show proxy health and running state
  doctor    Check for exposed secrets and proxy health
  run       Start proxy in foreground
  help      Show this help

Options:
  --config, -c <path>   Config file (default: agentauth.json)
  --port, -p <port>     Override port from config
  --bind, -b <addr>     Override bind address (default: 127.0.0.1)
  --pid-file <path>     PID file (default: .agentauth.pid)
  --log-file <path>     Log file for daemon mode (default: agentauth.log)
  --install             (macOS) Install LaunchAgent for auto-start on login

Examples:
  agentauth init                    # Generate config from env
  agentauth start                   # Start background daemon
  agentauth start --install         # Start + install LaunchAgent (macOS)
  agentauth status                  # Check if running
  agentauth doctor                  # Full health check
  agentauth stop                    # Graceful shutdown
`);
}

// ─── helpers ───────────────────────────────────────────────────────────────

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function findIndexJs(): string {
  // Try dist/index.js relative to this file's location
  const distIndex = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'index.js');
  if (fs.existsSync(distIndex)) return distIndex;

  // Try relative to cwd
  const cwdDist = path.resolve('dist', 'index.js');
  if (fs.existsSync(cwdDist)) return cwdDist;

  // Try the file that's currently running
  const argv1 = process.argv[1];
  if (argv1 && argv1.endsWith('index.js')) return argv1;

  throw new Error('Cannot find dist/index.js. Run "npm run build" first.');
}

function installLaunchAgent(configPath: string, logFile: string): void {
  const indexPath = findIndexJs();
  const nodePath = process.execPath;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${indexPath}</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
  <key>WorkingDirectory</key>
  <string>${path.dirname(configPath)}</string>
</dict>
</plist>
`;

  const plistDir = LAUNCHD_PLIST_DIR;
  const plistPath = path.join(plistDir, `${LAUNCHD_LABEL}.plist`);

  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  fs.writeFileSync(plistPath, plist);
  console.log(`\nLaunchAgent installed: ${plistPath}`);

  try {
    execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' });
    console.log('LaunchAgent loaded. Proxy will auto-start on login.');
  } catch {
    console.log('LaunchAgent written but could not load (are you in a container?).');
    console.log(`Load manually: launchctl load ${plistPath}`);
  }
}

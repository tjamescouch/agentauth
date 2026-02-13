#!/usr/bin/env node

/**
 * agentauth — localhost HTTP proxy for secret injection.
 *
 * Usage:
 *   agentauth [config.json]
 *   agentauth --help
 */

import { loadConfig } from './config.js';
import { AuditLog } from './audit.js';
import { AuthProxy } from './proxy.js';

// Re-export for programmatic use
export { loadConfig, isPathAllowed } from './config.js';
export { AuditLog } from './audit.js';
export { AuthProxy } from './proxy.js';
export type { AgentAuthConfig, BackendConfig } from './config.js';
export type { AuditEntry } from './audit.js';
export type { ProxyOptions } from './proxy.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`agentauth — localhost HTTP proxy for secret injection

Usage: agentauth [options] [config.json]

Options:
  --help, -h    Show this help
  --port, -p    Override port from config
  --bind, -b    Override bind address (default: 127.0.0.1)

Config file format (JSON):
  {
    "port": 9999,
    "auditLog": "./audit.log",
    "backends": {
      "anthropic": {
        "target": "https://api.anthropic.com",
        "headers": { "x-api-key": "$ANTHROPIC_API_KEY" },
        "allowedPaths": ["/v1/messages"]
      }
    }
  }

Header values starting with $ are resolved from environment variables.
Agents call http://localhost:PORT/{backend}/path to proxy requests.
`);
    return;
  }

  // Find config path
  let configPath = 'agentauth.json';
  let portOverride: number | null = null;
  let bindOverride: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      portOverride = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--bind' || args[i] === '-b') {
      bindOverride = args[i + 1];
      i++;
    } else if (!args[i].startsWith('-')) {
      configPath = args[i];
    }
  }

  // Load config
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`Failed to load config from ${configPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (portOverride) {
    config.port = portOverride;
  }
  if (bindOverride) {
    config.bind = bindOverride;
  }

  // Set up audit log
  let auditLog: AuditLog | undefined;
  if (config.auditLog) {
    auditLog = new AuditLog(config.auditLog);
    auditLog.open();
  }

  // Start proxy
  const proxy = new AuthProxy({ config, auditLog });

  const gracefulStop = async (): Promise<void> => {
    console.log('\nShutting down...');
    await proxy.stop();
    if (auditLog) auditLog.close();
    process.exit(0);
  };

  process.on('SIGINT', gracefulStop);
  process.on('SIGTERM', gracefulStop);

  await proxy.start();

  const backends = Object.keys(config.backends);
  console.log(`agentauth proxy listening on http://${config.bind}:${config.port}`);
  console.log(`Backends: ${backends.join(', ')}`);
  for (const name of backends) {
    console.log(`  /${name}/* → ${config.backends[name].target}`);
  }
  if (auditLog) {
    console.log(`Audit log: ${config.auditLog}`);
  }
}

// Only run main if executed directly (not imported)
const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

#!/usr/bin/env node

/**
 * agentauth — localhost HTTP proxy for secret injection.
 *
 * Usage:
 *   agentauth <command> [options]
 *   agentauth [config.json]          Start proxy in foreground (legacy)
 */

import { loadConfig } from './config.js';
import { AuditLog } from './audit.js';
import { AuthProxy } from './proxy.js';
import { cmdInit, cmdStart, cmdStop, cmdStatus, cmdDoctor, showHelp } from './cli.js';

// Re-export for programmatic use
export { loadConfig, isPathAllowed } from './config.js';
export { AuditLog } from './audit.js';
export { AuthProxy } from './proxy.js';
export type { AgentAuthConfig, BackendConfig } from './config.js';
export type { AuditEntry } from './audit.js';
export type { ProxyOptions } from './proxy.js';

const SUBCOMMANDS = new Set(['init', 'start', 'stop', 'status', 'doctor', 'run', 'help']);

/**
 * Run proxy in foreground (the original behavior).
 */
async function runForeground(args: string[]): Promise<void> {
  // Find config path and overrides
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case 'init':
      await cmdInit(commandArgs);
      break;
    case 'start':
      await cmdStart(commandArgs);
      break;
    case 'stop':
      await cmdStop(commandArgs);
      break;
    case 'status':
      await cmdStatus(commandArgs);
      break;
    case 'doctor':
      await cmdDoctor(commandArgs);
      break;
    case 'run':
      await runForeground(commandArgs);
      break;
    case 'help':
      showHelp();
      break;
    default:
      // Legacy: treat first arg as config path → foreground mode
      if (!command.startsWith('-')) {
        await runForeground(args);
      } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run "agentauth help" for usage.');
        process.exit(1);
      }
      break;
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

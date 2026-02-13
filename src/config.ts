/**
 * Config — load and validate agentauth configuration.
 *
 * Config format:
 * {
 *   "port": 9999,
 *   "backends": {
 *     "anthropic": {
 *       "target": "https://api.anthropic.com",
 *       "headers": { "x-api-key": "$ANTHROPIC_API_KEY" },
 *       "allowedPaths": ["/v1/messages"]
 *     }
 *   }
 * }
 *
 * Header values starting with $ are resolved from environment variables.
 */

import fs from 'fs';

export interface BackendConfig {
  target: string;
  headers: Record<string, string>;
  allowedPaths?: string[];
}

export interface AgentAuthConfig {
  port: number;
  bind: string;
  backends: Record<string, BackendConfig>;
  auditLog?: string;
}

/**
 * Load config from a JSON file.
 * Resolves $ENV_VAR references in header values.
 */
export function loadConfig(configPath: string): AgentAuthConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw) as AgentAuthConfig;

  if (!config.backends || typeof config.backends !== 'object') {
    throw new Error('Config must have a "backends" object');
  }

  if (Object.keys(config.backends).length === 0) {
    throw new Error('Config must have at least one backend');
  }

  config.port = config.port || 9999;
  config.bind = config.bind || '127.0.0.1';

  // Resolve environment variables in header values
  for (const [name, backend] of Object.entries(config.backends)) {
    if (!backend.target) {
      throw new Error(`Backend "${name}" must have a "target" URL`);
    }
    if (!backend.headers) {
      backend.headers = {};
    }

    for (const [key, value] of Object.entries(backend.headers)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const envVar = value.slice(1);
        const envValue = process.env[envVar];
        if (!envValue) {
          throw new Error(`Backend "${name}" header "${key}" references $${envVar} but it is not set`);
        }
        backend.headers[key] = envValue;
      }
    }
  }

  return config;
}

/**
 * Check if a request path is allowed for a backend.
 * Supports glob-like patterns with trailing *.
 */
export function isPathAllowed(path: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true;

  for (const pattern of allowedPaths) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (path.startsWith(prefix)) return true;
    } else {
      if (path === pattern) return true;
    }
  }

  return false;
}

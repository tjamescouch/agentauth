# agentauth

Localhost HTTP proxy for injecting auth headers — agents never see API keys.

## Features

- **Path-based routing** — `/{backend}/{path}` routes to configured upstreams
- **Secret injection** — Resolves `$ENV_VAR` references in header config at runtime
- **Path allowlisting** — Restrict backends to specific API paths with glob patterns
- **NDJSON audit log** — Every proxied request logged with timestamp, method, path, status
- **Localhost-only** — Binds to 127.0.0.1, never exposed to the network

## Quick Start

```bash
npm install
npm run build

# Set your secrets as env vars
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN_BEARER="Bearer ghp_..."

# Start the proxy
agentauth config.json
```

See [agentauth.example.json](agentauth.example.json) for example configuration.

## Configuration

```json
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
```

## Responsible Use

This software is intended for authorized security testing, research, and development only. Do not use it against systems you do not own or have explicit written permission to test. Users are solely responsible for ensuring their use complies with all applicable laws and regulations. Unauthorized access to computer systems is illegal.

## License

MIT

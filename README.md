# agentauth

Localhost HTTP proxy that injects auth headers from macOS Keychain — agents never see API keys.

## How It Works

```
┌──── Your Mac ────────────────────────────────┐
│                                               │
│  macOS Keychain (stores API keys)             │
│       ↓                                       │
│  agentauth proxy :9999 (reads Keychain)       │
│       ↑                                       │
│  ┌── Lima VM ──────────────────────────────┐  │
│  │  Agent containers hit proxy at          │  │
│  │  http://host.lima.internal:9999         │  │
│  │  Agents receive ANTHROPIC_BASE_URL      │  │
│  │  but never a real API key               │  │
│  └─────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
```

Agents inside the VM receive `ANTHROPIC_BASE_URL=http://host.lima.internal:9999/anthropic` and make API calls through the proxy. The proxy reads keys from macOS Keychain at request time, injects the auth header, and forwards the request upstream. Keys never enter the VM or container environment.

## Quick Start (with thesystem)

```bash
# Store API keys in macOS Keychain (one-time)
thesystem keys set anthropic sk-ant-...
thesystem keys set openai sk-...

# Start everything (proxy auto-starts)
thesystem start

# Verify proxy health
curl http://localhost:9999/agentauth/health
```

## Quick Start (standalone)

```bash
npm install
npm run build

# Store keys in macOS Keychain manually
security add-generic-password -a anthropic -s thesystem/anthropic -w "sk-ant-..." -U
security add-generic-password -a openai -s thesystem/openai -w "sk-..." -U

# Start the proxy
agentauth config.json
```

## Features

- **macOS Keychain integration** — Keys stored in Keychain, read at request time, never in env vars or config files
- **Path-based routing** — `/{backend}/{path}` routes to configured upstreams (Anthropic, OpenAI, GitHub)
- **Streaming support** — Proxies SSE/streaming responses for chat completions
- **Path allowlisting** — Restrict backends to specific API paths with glob patterns
- **NDJSON audit log** — Every proxied request logged with timestamp, method, path, status
- **Git credential support** — `/agentauth/credential/{provider}` endpoint for `git-credential-agentauth`

## Endpoints

| Path | Upstream | Auth Header |
|------|----------|-------------|
| `/anthropic/*` | `https://api.anthropic.com/*` | `x-api-key` from Keychain |
| `/openai/*` | `https://api.openai.com/*` | `Authorization: Bearer` from Keychain |
| `/agentauth/health` | (local) | Returns proxy status and supported backends |
| `/agentauth/credential/{provider}` | (local) | Returns token for git-credential-agentauth |

## Keychain Storage

Keys are stored as macOS generic passwords:

| Provider | Service Name | Account |
|----------|-------------|---------|
| Anthropic | `thesystem/anthropic` | `anthropic` |
| OpenAI | `thesystem/openai` | `openai` |
| GitHub | `thesystem/github` | `github` |

```bash
# Read a key (verify it's stored)
security find-generic-password -a anthropic -s thesystem/anthropic -w

# Update a key
security add-generic-password -a anthropic -s thesystem/anthropic -w "new-key" -U

# Delete a key
security delete-generic-password -a anthropic -s thesystem/anthropic
```

## Configuration

The proxy can also run in standalone config-file mode (legacy):

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

In config-file mode, `$ENV_VAR` references in headers are resolved from environment variables at runtime. The Keychain-based mode (via `thesystem`) is preferred.

## Agent Configuration

Agents inside the VM should set these environment variables:

```bash
export ANTHROPIC_BASE_URL=http://host.lima.internal:9999/anthropic
export OPENAI_BASE_URL=http://host.lima.internal:9999/openai
```

These are injected automatically by `thesystem` / `agentctl-swarm`.

## Security

- The proxy binds to `0.0.0.0` so Lima VM containers can reach it via `host.lima.internal`
- Restrict external access via macOS firewall
- Keys are read from Keychain per-request — never stored in process memory long-term
- All requests are logged to the NDJSON audit log

## Responsible Use

This software is intended for authorized security testing, research, and development only. Do not use it against systems you do not own or have explicit written permission to test. Users are solely responsible for ensuring their use complies with all applicable laws and regulations.

## License

MIT

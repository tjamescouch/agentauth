# agentauth

Localhost HTTP reverse proxy for secret injection. Agents never see API keys.

## Problem

Agents need to call upstream APIs (Anthropic, GitHub, etc.) but giving them raw API keys is a security liability. Keys leak through environment variables, process trees, error messages, and logs. A compromised agent with a raw key has unlimited access.

## Solution

A localhost proxy that sits between agents and upstream APIs. Agents send unauthenticated requests to `http://localhost:9999/{backend}/{path}`. The proxy injects the real auth headers and forwards to the upstream. Keys live only in the proxy process on the trusted host.

## State

- Loaded configuration (backends, headers, allowedPaths, port, bind)
- Resolved secrets (env vars resolved once at startup, held in memory)
- Open audit log file handle (append-only NDJSON)
- HTTP server instance

## Components

### proxy

The HTTP reverse proxy server.

**Capabilities:**
- Route `/{backend}/{path}` to configured upstream targets
- Inject auth headers per-backend (backend headers override client headers)
- Validate paths against allowedPaths glob patterns
- Reject path traversal (decode URL encoding, reject `..` segments)
- Enforce request body size limits per-backend (default 10 MiB)
- Filter response headers (allowlist: content-type, content-length, cache-control, etag, vary, transfer-encoding, date, content-encoding)
- Sanitize upstream error messages (agent sees "upstream unavailable", real error goes to audit)
- Health endpoint: `GET /agentauth/health` returns `{ status, backends, port }`

**Interfaces:**
- Exposes: HTTP server on `{bind}:{port}` (default `127.0.0.1:9999`)
- Depends on: config (loaded configuration), audit (logging)

**Invariants:**
- Binds to localhost only by default (not 0.0.0.0)
- Agents never see raw API keys in any response
- Every request is audit-logged before forwarding
- Unknown backends return 403
- Disallowed paths return 403

### config

Configuration loading and validation.

**Capabilities:**
- Load JSON config from file path
- Resolve `$ENV_VAR` references in header values at startup (fail-fast on missing)
- Validate backend structure (target URL required)
- Set defaults (port: 9999, bind: 127.0.0.1)
- Path allowlist matching: exact match or `prefix*` glob

**Interfaces:**
- Exposes: `loadConfig(path)`, `isPathAllowed(path, patterns)`
- Depends on: filesystem, environment variables

**Invariants:**
- Missing env var throws immediately (no silent empty string)
- Empty backends object throws
- Backend without target throws

### audit

NDJSON append-only audit logging.

**Capabilities:**
- Open log file (creates directory if needed)
- Write structured audit entry per request
- Read back entries (for testing/debugging)

**Interfaces:**
- Exposes: `open()`, `write(entry)`, `read()`, `close()`
- Depends on: filesystem

**Entry schema:**
```json
{
  "ts": "ISO-8601",
  "backend": "string",
  "method": "string",
  "path": "string (decoded, no query string)",
  "status": "number (optional)",
  "durationMs": "number (optional)",
  "allowed": "boolean",
  "reason": "string (optional, on denial)"
}
```

## Configuration Format

```json
{
  "port": 9999,
  "bind": "127.0.0.1",
  "auditLog": "./audit.log",
  "backends": {
    "anthropic": {
      "target": "https://api.anthropic.com",
      "headers": {
        "x-api-key": "$ANTHROPIC_API_KEY",
        "anthropic-version": "2023-06-01"
      },
      "allowedPaths": ["/v1/messages"],
      "maxBodyBytes": 10485760
    },
    "github": {
      "target": "https://api.github.com",
      "headers": {
        "authorization": "$GITHUB_TOKEN_BEARER",
        "accept": "application/vnd.github+json"
      },
      "allowedPaths": ["/repos/tjamescouch/*"]
    }
  }
}
```

## Request Flow

```
Agent                    agentauth proxy              Upstream API
  |                           |                           |
  |-- POST /anthropic/       |                           |
  |   v1/messages ---------->|                           |
  |   (no real API key)      |-- validate path --------->|
  |                          |-- inject x-api-key ------>|
  |                          |-- POST /v1/messages ----->|
  |                          |   x-api-key: sk-ant-xxx  |
  |                          |                           |
  |                          |<-- 200 OK ----------------|
  |                          |-- strip response hdrs --->|
  |<-- 200 OK ---------------|-- audit log entry ------->|
```

## Deployment

### Bare metal (Layer 0)
1. `npm install && npm run build`
2. Export secrets on host: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN_BEARER`
3. `agentauth agentauth.json`
4. Verify: `curl http://localhost:9999/agentauth/health`
5. Spawn agents with `ANTHROPIC_BASE_URL=http://localhost:9999/anthropic` and `ANTHROPIC_API_KEY=proxy-managed`
6. Strip real keys from agent environment (`env -i`)

### Podman containers
Same as bare metal, but agents reach proxy via `http://host.containers.internal:9999/anthropic`.

### thesystem (Lima VM)
Proxy runs on Mac host. VM agents reach it via `http://host.lima.internal:9999/anthropic`. Orchestrator strips secret-bearing env vars from forwarding.

## Security Properties

1. **Secret isolation** — Keys exist only in the proxy process on the trusted host
2. **Path restriction** — Agents can only hit allowlisted API endpoints
3. **Audit trail** — Every request logged with backend, method, path, status, duration
4. **Error sanitization** — Upstream errors never forwarded to agents
5. **Response filtering** — Only safe response headers forwarded
6. **Size limits** — Configurable per-backend request body limits
7. **Path traversal protection** — URL decoding + `..` rejection
8. **Localhost binding** — Not network-accessible by default

## Vendor Neutrality

The proxy is inherently vendor-neutral. Adding a new provider is one config block:

```json
"openai": {
  "target": "https://api.openai.com",
  "headers": { "authorization": "Bearer $OPENAI_API_KEY" },
  "allowedPaths": ["/v1/chat/completions", "/v1/models"]
}
```

No code changes required. Any HTTP API with header-based auth works.

## What This Does NOT Do

- No per-agent rate limiting (future: rate limit by source IP or agent identity)
- No request/response encryption (localhost only, trusted network)
- No agent identity verification (future: integrate with agentchat ed25519 identity)
- No token rotation (keys are static in env vars; future: Keychain integration)
- No multi-tenant isolation (all agents share the same backend keys)

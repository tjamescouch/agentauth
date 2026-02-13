# proxy

the core reverse proxy that handles routing, header injection, and response filtering.

## state

- config: loaded backend definitions (target URL, headers, allowed paths, max body size)
- server: Node.js HTTP server instance
- audit log: file descriptor for NDJSON logging

## capabilities

- route `/{backend}/{path}` to `backend.target/{path}`
- inject configured auth headers on every proxied request (overrides agent-sent headers)
- check request paths against per-backend allowlists (exact match or glob with trailing *)
- decode URL-encoded paths and reject path traversal (`..` after decode)
- strip response headers that leak upstream info (server, x-request-id, via, cf-ray, etc.)
- enforce per-backend request body size limits (default 10 MiB)
- sanitize upstream error messages (agent sees "upstream unavailable", real error in audit)
- health check endpoint at `/agentauth/health`
- credential endpoint at `/agentauth/credential/{backend}` for git credential helpers

## interfaces

exposes:
- HTTP server on `config.bind:config.port` (default 127.0.0.1:9999)
- `start()` / `stop()` lifecycle methods
- health check JSON: `{ status, backends, port }`

depends on:
- config-loader (for backend definitions)
- audit-log (for NDJSON logging)

## invariants

- binds to localhost only — never 0.0.0.0
- auth headers always override agent-sent headers (agent cannot inject its own credentials)
- path traversal is rejected after URL decoding
- every request (allowed or denied) is audit-logged
- upstream error details never reach the agent

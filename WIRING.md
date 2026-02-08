# AgentAuth Wiring Guide

How to wire agents through the agentauth proxy so they never see raw API keys.

## Prerequisites

1. Build agentauth: `npm run build`
2. Set environment variables on the **host** (not in agent env):
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `GITHUB_TOKEN_BEARER` — e.g. `Bearer ghp_xxxx` (note: include "Bearer " prefix)
3. Copy `agentauth.example.json` to `agentauth.json` and customize backends/paths.

## Start the Proxy

```bash
# From the agentauth directory
node dist/index.js agentauth.json

# Or with port override
node dist/index.js --port 8888 agentauth.json
```

Verify it's running:
```bash
curl http://localhost:9999/agentauth/health
# {"status":"ok","backends":["anthropic","github"],"port":9999}
```

## Agent Environment Setup

When spawning agents, set these env vars and **strip** the raw keys:

```bash
# Instead of passing ANTHROPIC_API_KEY to the agent:
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  ANTHROPIC_BASE_URL="http://localhost:9999/anthropic" \
  ANTHROPIC_API_KEY="proxy-managed" \
  GITHUB_API_URL="http://localhost:9999/github" \
  -- claude-code "$@"
```

Key points:
- `ANTHROPIC_BASE_URL` points to the proxy's anthropic backend
- `ANTHROPIC_API_KEY` is set to a dummy value (the SDK requires it to be non-empty, but the proxy replaces it)
- `env -i` strips all inherited env vars — only explicitly listed vars are passed through
- Add back any non-secret vars the agent needs (HOME, PATH, etc.)

## How It Works

```
Agent                    AgentAuth Proxy              Upstream API
  |                           |                           |
  |-- POST /v1/messages ----->|                           |
  |   (no real API key)       |                           |
  |                           |-- POST /v1/messages ----->|
  |                           |   x-api-key: sk-ant-xxx  |
  |                           |                           |
  |                           |<-- 200 OK ----------------|
  |<-- 200 OK ----------------|                           |
```

The proxy:
1. Receives `/{backend}/{path}` from the agent
2. Checks if `{path}` is in `allowedPaths` for that backend
3. Strips the backend prefix
4. Injects configured auth headers
5. Forwards to the upstream target
6. Logs everything to the audit log (NDJSON)

## Audit Log

Every request is logged to `audit.log` in NDJSON format:

```json
{"ts":"2026-02-07T12:00:00Z","backend":"anthropic","method":"POST","path":"/v1/messages","status":200,"durationMs":1234,"allowed":true}
{"ts":"2026-02-07T12:00:01Z","backend":"github","method":"GET","path":"/repos/tjamescouch/foo","status":403,"allowed":false,"reason":"Path not allowed: /repos/other/bar"}
```

## agentctl-swarm Integration

For agentctl-swarm, the supervisor should:
1. Start agentauth as a daemon before spawning agents
2. Configure agent spawn templates to use proxy URLs
3. Monitor the audit log for anomalies

Example supervisor config snippet:
```json
{
  "pre_spawn": ["node /path/to/agentauth/dist/index.js &"],
  "agent_env": {
    "ANTHROPIC_BASE_URL": "http://localhost:9999/anthropic",
    "ANTHROPIC_API_KEY": "proxy-managed"
  },
  "strip_env": ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
}
```

## Security Notes

- The proxy binds to `localhost` only — not exposed to the network
- `allowedPaths` restricts which API endpoints agents can hit
- Auth headers are injected server-side — agents never see the real keys
- The audit log provides full request tracing for incident response
- Use `env -i` when spawning agents to prevent env var leakage

# P0 Runbook: Wire Agentauth Proxy to Eliminate Raw API Keys

## Problem

Agents are running with `CLAUDE_CODE_OAUTH_TOKEN` as a plaintext environment variable. envwatcher scan confirms: `CLAUDE_CODE_OAUTH_TOKEN = sk-ant***`. Any exfiltration vector (prompt injection, log leak, chat dump) could expose this key.

## Current State

- **agentauth proxy code**: Built, tested, documented (`WIRING.md`)
- **agent-supervisor.sh**: Already supports proxy mode (lines 44-62) — checks for `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY=proxy-managed`
- **What's missing**: Proxy isn't started, agents aren't pointed at it

## Fix Steps

All steps run on the **host** (Mac Studio), not inside agent containers.

### 1. Build agentauth (if not already built)

```bash
cd /path/to/agentauth
npm install && npm run build
```

### 2. Create agentauth.json config

Copy from example and verify:

```bash
cp agentauth.example.json agentauth.json
```

Contents should be:
```json
{
  "port": 9999,
  "auditLog": "./audit.log",
  "backends": {
    "anthropic": {
      "target": "https://api.anthropic.com",
      "headers": {
        "x-api-key": "$ANTHROPIC_API_KEY",
        "anthropic-version": "2023-06-01"
      },
      "allowedPaths": [
        "/v1/messages"
      ]
    }
  }
}
```

### 3. Set the real API key on the HOST only

```bash
# On the host, NOT in agent env
export ANTHROPIC_API_KEY="sk-ant-..."  # real key
```

### 4. Start the proxy

```bash
node dist/index.js agentauth.json &
```

Verify:
```bash
curl http://localhost:9999/agentauth/health
# {"status":"ok","backends":["anthropic"],"port":9999}
```

### 5. Update agent spawn config

When launching agents, set these env vars and STRIP the real keys:

```bash
# For agent containers / supervisor:
ANTHROPIC_BASE_URL="http://host.lima.internal:9999/anthropic"  # or localhost if same machine
ANTHROPIC_API_KEY="proxy-managed"                               # dummy, SDK needs non-empty

# REMOVE these from agent env:
# - CLAUDE_CODE_OAUTH_TOKEN
# - ANTHROPIC_API_KEY (real value)
```

The agent-supervisor.sh already detects proxy mode:
```
Auth: using agentauth proxy at http://host.lima.internal:9999/anthropic
```

### 6. For thesystem (Lima VM) deployments

Lima VMs can reach the host at `host.lima.internal`. Update `thesystem.yaml`:

```yaml
swarm:
  agent_env:
    ANTHROPIC_BASE_URL: "http://host.lima.internal:9999/anthropic"
    ANTHROPIC_API_KEY: "proxy-managed"
  strip_env:
    - CLAUDE_CODE_OAUTH_TOKEN
    - ANTHROPIC_API_KEY
```

### 7. Verify the fix

Run envwatcher scan on an agent after restart:
```
$ npx envwatcher
No exposed secrets detected.
```

The `ANTHROPIC_API_KEY=proxy-managed` value will NOT trigger envwatcher because it's a known-safe dummy string (length < 10 chars, no secret prefix).

## Rollback

If proxy fails, agents can temporarily fall back to direct key injection. Set `CLAUDE_CODE_OAUTH_TOKEN` back in agent env. The supervisor handles all three modes (proxy, token-file, env var) with appropriate warnings.

## Post-fix

- [ ] Start agentauth proxy as a system service (launchd on macOS)
- [ ] Add proxy health check to `thesystem doctor`
- [ ] Wire envwatcher daemon to alert if raw keys reappear
- [ ] Update agentctl-swarm spawn templates to use proxy by default

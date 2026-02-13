# envwatcher

startup health check for agent environments. scans process.env for exposed secrets that should be proxy-managed, warns loudly, never blocks.

## problem

agents running inside containers shouldn't have raw API keys in their environment. when they do, any code the agent executes (including untrusted tool calls) can read and exfiltrate those secrets. the agentauth proxy exists to solve this, but misconfiguration happens — and there's no feedback when it does.

## what it does

on agent boot, envwatcher:

1. scans all env vars for potential secrets
2. prints a loud warning to stderr if any are found
3. returns findings as structured data for programmatic use
4. exits cleanly — warn-only, never blocks startup

## detection strategy

two layers, independent:

### value pattern matching (high confidence)
recognizes known secret formats by their prefix/structure:
- `sk-ant-*` — Anthropic API key
- `sk-*` — OpenAI API key
- `ghp_*`, `gho_*`, `ghs_*`, `github_pat_*` — GitHub tokens
- `AKIA*` — AWS access key
- `xoxb-*`, `xoxp-*` — Slack tokens
- `eyJ*` — JWT
- `Bearer *` — bearer token

### name pattern matching (medium confidence)
flags env vars with names containing: `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `PRIVATE`, `BEARER`

### safe list
skips known-safe values: `proxy-managed`, `placeholder`, `none`, `disabled`, empty string. skips known-safe names: `TERM`, `SSH_AUTH_SOCK`, etc.

## output format

stderr, human-readable, values redacted:

```
╔══════════════════════════════════════════════════════════════╗
║  WARNING: Potential secrets found in environment            ║
╚══════════════════════════════════════════════════════════════╝

  ANTHROPIC_API_KEY = sk-a***  (Anthropic API key)
  GITHUB_TOKEN = ghp_***  (GitHub PAT)

  These should be managed by the agentauth proxy, not passed
  directly to agent environments. See: agentauth WIRING.md
```

when clean:
```
✓ Environment clean — no exposed secrets detected.
```

## API

```typescript
import { envDoctor } from 'envwatcher';

const findings = envDoctor();
// findings: Array<{ name: string, redacted: string, reason: string }>
```

## standalone

```bash
node envwatcher.js        # scans current env, exits 0 (clean) or 1 (findings)
```

## integration points

- agent bootstrap (gro, agentctl, any runner)
- CI/CD pre-deploy checks
- container entrypoint scripts
- agentauth proxy startup (verify own env is clean before serving)

## constraints

- zero dependencies
- single file, < 200 lines
- never prints raw secret values — always redact to first 4 chars + `***`
- never blocks — warn and return, agent decides what to do
- POSIX-compatible output (no emoji in core output, box drawing is fine)
- extensible: adding new patterns = adding one line

## non-goals

- no runtime monitoring (this is a point-in-time boot check)
- no auto-remediation (not envwatcher's job to fix the config)
- no network calls
- no file system access beyond process.env

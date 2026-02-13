# env-doctor

startup health check that scans the process environment for exposed secrets.

## state

- findings: list of suspect env vars with name, redacted value, and reason

## capabilities

- scan `process.env` for vars matching secret name patterns (key, token, secret, password, credential, auth, bearer, private)
- identify known secret value patterns (sk-ant-, sk-, ghp_, gho_, ghs_, AKIA, xoxb-, eyJ)
- skip known-safe names (TERM, SSH_AUTH_SOCK, etc.) and safe values (proxy-managed, placeholder, none)
- print formatted warning box to stderr with all findings
- exit with code 1 if secrets found (for use in CI/pre-start checks)

## interfaces

exposes:
- `envDoctor(): Finding[]` — programmatic API
- standalone CLI: `node dist/env-doctor.js`

depends on:
- nothing (standalone module)

## invariants

- never logs actual secret values — always redacted (first 4 chars + ***)
- warns but does not block — agents can still start (defense in depth, not gatekeeping)
- known-safe values like "proxy-managed" are never flagged

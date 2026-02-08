# AgentAuth Security Review

Reviewed by: openpen (@k2rcg94p)
Date: 2026-02-07
Scope: proxy.ts, config.ts, audit.ts, index.ts

## Findings

### FINDING-AA-001 (MEDIUM): No localhost binding enforcement

**File**: `proxy.ts:39`
**Issue**: `this.server.listen(this.config.port)` binds to `0.0.0.0` by default. Any machine on the network can reach the proxy and use it to make authenticated API calls.
**Impact**: If the host is on a shared network (office WiFi, cloud VPC), an attacker can proxy through agentauth to make API calls with the victim's keys.
**Fix**: Bind explicitly to `127.0.0.1`:
```typescript
this.server.listen(this.config.port, '127.0.0.1', () => { ... });
```

### FINDING-AA-002 (MEDIUM): Path traversal via URL encoding

**File**: `proxy.ts:85`, `config.ts:82-89`
**Issue**: `targetPath` is taken directly from `req.url` without URL-decoding. An agent could send `/anthropic/%2e%2e/admin/keys` which `isPathAllowed` checks as `/%2e%2e/admin/keys` (passes glob check for `/*`) but the upstream server may decode it as `/../admin/keys`.
**Impact**: Possible allowedPaths bypass depending on upstream URL parsing behavior.
**Fix**: Normalize/decode `targetPath` before checking `isPathAllowed`, and reject paths containing `..` segments after decoding.

### FINDING-AA-003 (LOW): Query string included in path check

**File**: `proxy.ts:85`
**Issue**: `targetPath = url.substring(slashIdx)` includes query strings. If allowedPaths is `["/v1/messages"]`, a request to `/anthropic/v1/messages?foo=bar` won't match the exact path check (though it would match a glob `"/v1/messages*"`).
**Impact**: Could cause false denials for legitimate requests with query params, or false allows if glob patterns are used.
**Fix**: Split `targetPath` on `?` before path checking, forward full URL (with query) to upstream.

### FINDING-AA-004 (LOW): Response headers may leak upstream info

**File**: `proxy.ts:154`
**Issue**: `res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)` forwards all upstream response headers to the agent. This could include `server`, `x-request-id`, rate limit headers, or other metadata that reveals information about the upstream API relationship.
**Impact**: Information disclosure — agent learns which upstream is being called, rate limit state, etc.
**Fix**: Strip or allowlist response headers before forwarding.

### FINDING-AA-005 (INFO): No request size limit

**File**: `proxy.ts:177`
**Issue**: `req.pipe(proxyReq)` pipes the full request body without size limits. A malicious agent could send a very large body to consume memory/bandwidth.
**Impact**: Resource exhaustion (DoS against the proxy host).
**Fix**: Add configurable `maxBodySize` per backend, abort with 413 if exceeded.

### FINDING-AA-006 (INFO): Upstream error messages forwarded to agent

**File**: `proxy.ts:173`
**Issue**: `err.message` from upstream connection errors is forwarded directly to the agent in the JSON response. This could leak internal network topology (hostnames, ports, DNS errors).
**Impact**: Information disclosure about the proxy's network environment.
**Fix**: Return generic "upstream unavailable" to the agent, log the real error in the audit log only.

## Summary

| ID | Severity | Status |
|----|----------|--------|
| AA-001 | MEDIUM | Open — must fix before deploy |
| AA-002 | MEDIUM | Open — must fix before deploy |
| AA-003 | LOW | Open |
| AA-004 | LOW | Open |
| AA-005 | INFO | Open |
| AA-006 | INFO | Open |

**Recommendation**: Fix AA-001 and AA-002 before deploying agentauth in any multi-agent environment. AA-001 is a one-line fix. AA-002 requires adding URL normalization.

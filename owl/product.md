# agentauth

localhost HTTP proxy that injects auth headers so agents never see API keys.

## what it is

a reverse proxy that sits between agents and upstream APIs. agents send requests to `localhost:9999/{backend}/{path}`, the proxy injects real credentials and forwards to the upstream. agents hold a dummy key (`proxy-managed`), never the real one.

## what it is not

- not a key vault — it reads secrets from the host environment (or Keychain in v2)
- not a network proxy — it only handles HTTP to known backends
- not an authorization system — it doesn't decide *who* can call, only injects *how* to call

## first principles

### axiom 1: agents never hold secrets

the proxy is the only component that touches real API keys. agents get proxy URLs and dummy keys. if an agent is compromised, no secrets are exposed.

### axiom 2: localhost only

the proxy binds to 127.0.0.1. it is never exposed to the network. containers reach it via `host.containers.internal` or Docker bridge. VMs reach it via `host.lima.internal`.

### axiom 3: audit everything

every proxied request is logged to NDJSON with timestamp, backend, method, path, status, duration, and allow/deny. the audit log is the source of truth for what agents did.

### axiom 4: defense in depth

path allowlisting restricts which API endpoints agents can hit. response header stripping prevents information leakage. body size limits prevent resource exhaustion. each layer catches what the previous layer missed.

## components

see below.

## constraints

- zero dependencies beyond Node.js stdlib
- TypeScript compiled to JavaScript
- config is a JSON file, secrets are `$ENV_VAR` references resolved at startup
- the proxy adds no latency beyond TCP forwarding (no request buffering except for size checking)

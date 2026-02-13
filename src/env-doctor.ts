/**
 * envDoctor — startup health check for agent environments.
 *
 * Scans process.env for potential secrets that shouldn't be directly
 * accessible to agents. Warns loudly but doesn't block.
 *
 * Usage:
 *   import { envDoctor } from './env-doctor.js';
 *   envDoctor();  // prints warnings to stderr
 *
 * Or standalone:
 *   node dist/env-doctor.js
 */

// Patterns that suggest a secret
const SECRET_PATTERNS = [
  /key$/i,
  /token$/i,
  /secret$/i,
  /password$/i,
  /credential/i,
  /^auth/i,
  /_auth$/i,
  /api.?key/i,
  /bearer/i,
  /private/i,
];

// Known-safe values that agents are expected to have
const SAFE_VALUES = new Set([
  'proxy-managed',
  'placeholder',
  'none',
  'disabled',
  'false',
  '',
]);

// Known-safe env var names (not secrets even if they match patterns)
const SAFE_NAMES = new Set([
  'TERM',
  'COLORTERM',
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
  'TOKENIZERS_PARALLELISM',
]);

// Patterns in values that indicate real secrets
const VALUE_PATTERNS = [
  { pattern: /^sk-ant-/, label: 'Anthropic API key' },
  { pattern: /^sk-/, label: 'OpenAI API key' },
  { pattern: /^ghp_/, label: 'GitHub PAT' },
  { pattern: /^gho_/, label: 'GitHub OAuth token' },
  { pattern: /^ghs_/, label: 'GitHub App token' },
  { pattern: /^github_pat_/, label: 'GitHub fine-grained PAT' },
  { pattern: /^Bearer\s+/, label: 'Bearer token' },
  { pattern: /^AKIA/, label: 'AWS access key' },
  { pattern: /^xoxb-/, label: 'Slack bot token' },
  { pattern: /^xoxp-/, label: 'Slack user token' },
  { pattern: /^eyJ/, label: 'JWT token' },
];

interface Finding {
  name: string;
  redacted: string;
  reason: string;
}

function redact(value: string): string {
  if (value.length <= 4) return '***';
  return value.slice(0, 4) + '***';
}

function isSuspectName(name: string): boolean {
  if (SAFE_NAMES.has(name)) return false;
  return SECRET_PATTERNS.some(p => p.test(name));
}

function identifyValue(value: string): string | null {
  for (const { pattern, label } of VALUE_PATTERNS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

export function envDoctor(): Finding[] {
  const findings: Finding[] = [];

  for (const [name, value] of Object.entries(process.env)) {
    if (!value || SAFE_VALUES.has(value.toLowerCase())) continue;

    // Check by value pattern first (most reliable signal)
    const valueMatch = identifyValue(value);
    if (valueMatch) {
      findings.push({
        name,
        redacted: redact(value),
        reason: valueMatch,
      });
      continue;
    }

    // Check by name pattern
    if (isSuspectName(name)) {
      findings.push({
        name,
        redacted: redact(value),
        reason: 'name matches secret pattern',
      });
    }
  }

  // Print warnings
  if (findings.length > 0) {
    const w = (s: string) => process.stderr.write(s + '\n');
    w('');
    w('╔══════════════════════════════════════════════════════════════╗');
    w('║  ⚠️  WARNING: Potential secrets found in environment        ║');
    w('╚══════════════════════════════════════════════════════════════╝');
    w('');
    for (const f of findings) {
      w(`  ${f.name} = ${f.redacted}  (${f.reason})`);
    }
    w('');
    w('  These should be managed by the agentauth proxy, not passed');
    w('  directly to agent environments. See: agentauth WIRING.md');
    w('');
  }

  return findings;
}

// Run standalone
const isMain = process.argv[1]?.includes('env-doctor');
if (isMain) {
  const findings = envDoctor();
  if (findings.length === 0) {
    console.log('✓ Environment clean — no exposed secrets detected.');
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

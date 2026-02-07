/**
 * Audit — NDJSON audit log for all proxied requests.
 *
 * Each entry records:
 *   - timestamp
 *   - backend name
 *   - method + path
 *   - status code from upstream
 *   - response time
 *   - whether the request was allowed or denied
 */

import fs from 'fs';

export interface AuditEntry {
  ts: string;
  backend: string;
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  allowed: boolean;
  reason?: string;
}

export class AuditLog {
  private fd: number | null = null;
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  open(): void {
    const dir = this.logPath.substring(0, this.logPath.lastIndexOf('/'));
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.fd = fs.openSync(this.logPath, 'a');
  }

  write(entry: AuditEntry): void {
    if (this.fd === null) return;
    const line = JSON.stringify(entry) + '\n';
    fs.writeSync(this.fd, line);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Read back entries for debugging/testing.
   */
  read(): AuditEntry[] {
    try {
      const content = fs.readFileSync(this.logPath, 'utf8');
      return content.trim().split('\n')
        .filter(l => l.length > 0)
        .map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }
}

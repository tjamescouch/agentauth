/**
 * Proxy — HTTP reverse proxy with auth header injection.
 *
 * Routes: /{backend}/{path} → backend.target/{path}
 * Injects configured headers on every proxied request.
 * Blocks requests to paths not in allowedPaths (if configured).
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { AgentAuthConfig, BackendConfig, isPathAllowed } from './config.js';
import { AuditLog, AuditEntry } from './audit.js';

/** Default max request body size: 10 MB */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Response headers safe to forward to the agent. */
const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'cache-control',
  'date',
  'etag',
  'vary',
]);

export interface ProxyOptions {
  config: AgentAuthConfig;
  auditLog?: AuditLog;
}

export class AuthProxy {
  private server: http.Server | null = null;
  private config: AgentAuthConfig;
  private auditLog: AuditLog | null;

  constructor(opts: ProxyOptions) {
    this.config = opts.config;
    this.auditLog = opts.auditLog || null;
  }

  /**
   * Start the proxy server.
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port, this.config.bind, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming proxy request.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Health check
    if (url === '/agentauth/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        backends: Object.keys(this.config.backends),
        port: this.config.port,
      }));
      return;
    }

    // Parse /{backend}/{path}
    const slashIdx = url.indexOf('/', 1);
    if (slashIdx === -1) {
      this.deny(res, 'invalid_path', `No backend in path: ${url}`, method, url);
      return;
    }

    const backendName = url.substring(1, slashIdx);
    const rawPath = url.substring(slashIdx);

    // Decode URL-encoded characters and reject path traversal
    let targetPath: string;
    try {
      targetPath = decodeURIComponent(rawPath.split('?')[0]);
    } catch {
      this.deny(res, 'invalid_path', `Malformed URL encoding: ${rawPath}`, method, url);
      return;
    }

    if (targetPath.includes('..')) {
      this.deny(res, 'path_traversal', `Path traversal rejected: ${targetPath}`, method, url);
      return;
    }

    // Re-append query string for forwarding
    const qIdx = rawPath.indexOf('?');
    const fullTargetPath = qIdx !== -1 ? targetPath + rawPath.substring(qIdx) : targetPath;

    const backend = this.config.backends[backendName];
    if (!backend) {
      this.deny(res, 'unknown_backend', `Unknown backend: ${backendName}`, method, url);
      return;
    }

    // Check allowed paths (decoded path without query string)
    if (!isPathAllowed(targetPath, backend.allowedPaths)) {
      this.deny(res, 'path_denied', `Path not allowed: ${targetPath}`, method, url, backendName);
      return;
    }

    // Forward request (use fullTargetPath to preserve query string)
    this.forward(req, res, backend, backendName, fullTargetPath, method);
  }

  /**
   * Forward request to upstream backend with injected headers.
   */
  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    backend: BackendConfig,
    backendName: string,
    targetPath: string,
    method: string
  ): void {
    const startTime = Date.now();
    const targetUrl = new URL(targetPath, backend.target);

    const isHttps = targetUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    // Build headers — copy original, then inject backend headers
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key !== 'host' && key !== 'connection') {
        headers[key] = value;
      }
    }

    // Inject auth headers (these override any client-sent headers)
    for (const [key, value] of Object.entries(backend.headers)) {
      headers[key] = value;
    }

    const proxyReq = requestModule.request(
      targetUrl.href,
      {
        method,
        headers: headers as http.OutgoingHttpHeaders,
      },
      (proxyRes) => {
        const durationMs = Date.now() - startTime;

        // Audit log
        this.audit({
          ts: new Date().toISOString(),
          backend: backendName,
          method,
          path: targetPath,
          status: proxyRes.statusCode,
          durationMs,
          allowed: true,
        });

        // Forward response with filtered headers (AA-004)
        const safeHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
            safeHeaders[key] = value;
          }
        }
        res.writeHead(proxyRes.statusCode || 502, safeHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      const durationMs = Date.now() - startTime;
      // Log real error for operators, return generic message to agent (AA-006)
      this.audit({
        ts: new Date().toISOString(),
        backend: backendName,
        method,
        path: targetPath,
        status: 502,
        durationMs,
        allowed: true,
        reason: `upstream error: ${err.message}`,
      });

      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_error', message: 'upstream unavailable' }));
      }
    });

    // Pipe request body with size limit (AA-005)
    const maxBody = backend.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBody) {
        req.destroy();
        proxyReq.destroy();
        this.audit({
          ts: new Date().toISOString(),
          backend: backendName,
          method,
          path: targetPath,
          status: 413,
          allowed: false,
          reason: `body exceeded ${maxBody} bytes`,
        });
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body_too_large', message: `Request body exceeds ${maxBody} byte limit` }));
        }
        return;
      }
      proxyReq.write(chunk);
    });
    req.on('end', () => {
      proxyReq.end();
    });
    req.on('error', () => {
      proxyReq.destroy();
    });
  }

  /**
   * Deny a request with an error response.
   */
  private deny(
    res: http.ServerResponse,
    code: string,
    message: string,
    method: string,
    path: string,
    backend?: string
  ): void {
    this.audit({
      ts: new Date().toISOString(),
      backend: backend || 'none',
      method,
      path,
      status: 403,
      allowed: false,
      reason: message,
    });

    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: code, message }));
  }

  /**
   * Write an audit entry.
   */
  private audit(entry: AuditEntry): void {
    if (this.auditLog) {
      this.auditLog.write(entry);
    }
  }

  get port(): number {
    return this.config.port;
  }
}

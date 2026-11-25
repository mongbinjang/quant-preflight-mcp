import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { VenueRouter } from './adapters/venueRouter.js';
import { BillingGate } from './billing/billingGate.js';
import { registerQuantPreflightTools } from './mcp/tools.js';
import { TenantRateLimiter } from './security/rateLimiter.js';

export const MAX_REQUEST_BYTES = 256 * 1024; // Strict 256KB OWASP payload ceiling

export interface QuantPreflightServerOptions {
  router?: VenueRouter;
  billing?: BillingGate;
  rateLimiter?: TenantRateLimiter;
}

/**
 * Creates the Stateless Multi-Tenant Express + Streamable HTTP MCP Server.
 * - `GET /health` -> `200 OK` `{ status: "ok", mode: "multi-tenant" }`
 * - `GET /mcp`, `DELETE /mcp` (and non-POST `/mcp`) -> `405 Method Not Allowed` JSON
 * - `POST /mcp` -> Stateless MCP JSON-RPC handler (`256KB` limit + `60/min` tenant rate limit)
 */
export function createQuantPreflightApp(opts?: QuantPreflightServerOptions) {
  const router = opts?.router ?? new VenueRouter();
  const billing = opts?.billing ?? new BillingGate();
  const rateLimiter = opts?.rateLimiter ?? new TenantRateLimiter({ maxRequestsPerWindow: 60, windowMs: 60_000 });

  const app = express();
  app.disable('x-powered-by');

  // Early Content-Length header check before buffering body
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rawLen = req.headers['content-length'];
    if (rawLen) {
      const len = Number(rawLen);
      if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) {
        res.status(413).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: `Payload Too Large: request exceeds ${MAX_REQUEST_BYTES} bytes (256KB) limit.`,
          },
          id: null,
        });
        return;
      }
    }
    next();
  });

  app.use(
    express.json({
      limit: MAX_REQUEST_BYTES,
    })
  );

  // Catch body-parser 413 PayloadTooLargeError and malformed JSON syntax errors cleanly ($0 charge)
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { statusCode?: number }).statusCode;
    const errType = (err as { type?: string }).type;

    if (status === 413 || errType === 'entity.too.large') {
      res.status(413).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: `Payload Too Large: request exceeds ${MAX_REQUEST_BYTES} bytes (256KB) limit.`,
        },
        id: null,
      });
      return;
    }

    if (err instanceof SyntaxError || errType === 'entity.parse.failed') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Parse error: malformed JSON payload.',
        },
        id: null,
      });
      return;
    }

    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal transport error.',
      },
      id: null,
    });
  });

  // Apify Standby Readiness Probe & MCPize Health Check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      mode: 'multi-tenant',
    });
  });

  // Phase 0 Refinement #4: Explicit JSON 405 Method Not Allowed on GET / DELETE / non-POST /mcp
  app.all('/mcp', async (req: Request, res: Response) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Method Not Allowed: ${req.method} /mcp is not supported on this stateless MCP server. Use POST /mcp.`,
        },
        id: null,
      });
      return;
    }

    // Zero-PII Sliding-Window Rate Limiter (hashes X-Apify-User-ID in volatile RAM only)
    const rawTenant =
      (req.headers['x-apify-user-id'] as string | undefined) ??
      req.ip ??
      req.socket.remoteAddress;
    const rl = rateLimiter.check(rawTenant);
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));

    if (!rl.allowed) {
      const retrySec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retrySec));
      res.status(429).json({
        jsonrpc: '2.0',
        error: {
          code: -32029,
          message: `Rate limit exceeded (max 60 requests/min). Retry after ${rl.retryAfterMs}ms.`,
          data: { retry_after_ms: rl.retryAfterMs },
        },
        id: null,
      });
      return;
    }

    // Normalize Accept header so both strict MCP SDK clients and plain JSON-RPC HTTP callers succeed
    const acceptHeader = req.headers.accept ?? '';
    if (!acceptHeader.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    const mcpServer = new McpServer({
      name: 'quant-preflight-mcp',
      version: '1.0.0',
    });
    registerQuantPreflightTools(mcpServer, { router, billing });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void mcpServer.close().catch(() => undefined);
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Stateless MCP request handling failed safely. Zero fee charged.',
          },
          id: null,
        });
      }
    }
  });

  // Catch-all JSON 404 for unknown routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      endpoints: {
        mcp: 'POST /mcp',
        health: 'GET /health',
      },
    });
  });

  return { app, router, billing, rateLimiter };
}

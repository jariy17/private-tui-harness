/**
 * HTTP transport module for the TUI harness MCP server.
 *
 * Exposes the MCP server over Streamable HTTP on a single `/mcp` endpoint.
 * Each inbound `initialize` request creates a new stateful session with its
 * own `McpServer` instance (via `createServer()`) backed by a dedicated
 * `StreamableHTTPServerTransport`. Subsequent requests are routed to the
 * correct transport using the `mcp-session-id` header.
 *
 * Supported HTTP methods on `/mcp`:
 *   POST   - Handles `initialize` (creates a new session) and all subsequent
 *            JSON-RPC requests (routed by session ID).
 *   GET    - Opens an SSE stream for server-initiated messages.
 *   DELETE - Terminates a session and cleans up its resources.
 *
 * The server binds to `127.0.0.1` only (no external access) and registers
 * `SIGTERM`/`SIGINT` handlers for graceful shutdown.
 */
import { closeAllSessions, createServer, getTuiSession, listTuiSessions } from './server.js';
import { createWebConsoleHandler } from '../web/routes.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

const sessions = new Map<string, ManagedSession>();

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      resolve(undefined);
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Failed to parse JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', (err: Error) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody(req);
  const sessionId = req.headers['mcp-session-id'];

  if (isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createServer();
    await server.connect(transport);

    await transport.handleRequest(req, res, body);

    const transportSessionId = transport.sessionId;
    if (transportSessionId !== undefined) {
      const managed: ManagedSession = { transport, server };
      sessions.set(transportSessionId, managed);

      transport.onclose = () => {
        sessions.delete(transportSessionId);
      };

      transport.onerror = (error: Error) => {
        process.stderr.write(`[mcp-http] Transport error (session ${transportSessionId}): ${error.message}\n`);
      };
    }

    return;
  }

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing mcp-session-id header.' }));
    return;
  }

  const managed = sessions.get(sessionId);
  if (!managed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found. It may have expired or been closed.' }));
    return;
  }

  await managed.transport.handleRequest(req, res, body);
}

async function handleGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing mcp-session-id header.' }));
    return;
  }

  const managed = sessions.get(sessionId);
  if (!managed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found. It may have expired or been closed.' }));
    return;
  }

  await managed.transport.handleRequest(req, res);
}

async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing mcp-session-id header.' }));
    return;
  }

  const managed = sessions.get(sessionId);
  if (!managed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found. It may have expired or been closed.' }));
    return;
  }

  await managed.transport.handleRequest(req, res);

  sessions.delete(sessionId);
  await managed.server.close();
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

/** Web console handler — created lazily on first request. */
const webConsole = createWebConsoleHandler(getTuiSession, listTuiSessions);

function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const handleRequest = async (): Promise<void> => {
    // Try web console routes first (/, /api/sessions, /api/sessions/:id/...)
    if (url.pathname !== '/mcp') {
      const handled = await webConsole(req, res);
      if (handled) return;

      // Not a console route and not /mcp — 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint: /mcp, Web console: /' }));
      return;
    }

    // MCP endpoint
    switch (req.method) {
      case 'POST':
        await handlePost(req, res);
        break;
      case 'GET':
        await handleGet(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
        res.end(JSON.stringify({ error: `Method ${req.method} not allowed.` }));
        break;
    }
  };

  handleRequest().catch((err: unknown) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    }
    process.stderr.write(`[mcp-http] Request error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the MCP HTTP server on the specified port.
 *
 * The server listens on `127.0.0.1` (localhost only) and routes all traffic
 * through the `/mcp` endpoint.
 */
export async function startHttpServer(port: number): Promise<void> {
  const httpServer = createHttpServer(dispatch);

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[mcp-http] Shutting down...\n');

    const closePromises = Array.from(sessions.values()).map(async managed => {
      try {
        await managed.transport.close();
        await managed.server.close();
      } catch {
        // Best-effort cleanup
      }
    });
    await Promise.allSettled(closePromises);
    sessions.clear();

    await closeAllSessions();

    httpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  return new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use. ` +
              'Try a different port with --port <number> or MCP_HARNESS_PORT=<number>.'
          )
        );
      } else {
        reject(err);
      }
    });

    httpServer.listen(port, '127.0.0.1', () => {
      process.stderr.write(`[mcp-http] MCP server listening at http://127.0.0.1:${port}/mcp\n`);
      process.stderr.write(`[mcp-http] Web console at http://127.0.0.1:${port}/\n`);
      process.stderr.write(`[mcp-http] TUI flow executor agent: npx tui-harness-mcp install-agent\n`);
      resolve();
    });
  });
}

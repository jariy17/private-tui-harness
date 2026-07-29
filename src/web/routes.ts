/**
 * Web console HTTP routes for the TUI harness.
 *
 * Provides a browser-based dashboard to view all active headless terminal
 * sessions, see live screen content, take SVG screenshots, and interactively
 * send keystrokes (terminal takeover).
 *
 * Routes:
 *   GET  /                               - Serves the console HTML
 *   GET  /api/sessions                   - List all sessions
 *   GET  /api/sessions/:id/screen        - Read a session's screen
 *   POST /api/sessions/:id/keys          - Send keys to a session
 *   GET  /api/sessions/:id/screenshot    - Get SVG screenshot
 *   POST /api/sessions/:id/close         - Close a session
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TuiSession } from '../lib/tui-session.js';
import type { CloseResult } from '../lib/types.js';
import type { SpecialKey } from '../lib/types.js';
import { SPECIAL_KEY_VALUES } from '../lib/types.js';

// ---------------------------------------------------------------------------
// HTML asset
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
let consoleHtml: string;
try {
  consoleHtml = readFileSync(resolve(__dirname, 'console.html'), 'utf-8');
} catch {
  // When running from dist/, the HTML might be alongside the JS
  try {
    consoleHtml = readFileSync(resolve(__dirname, '..', '..', 'src', 'web', 'console.html'), 'utf-8');
  } catch {
    consoleHtml = '<html><body><h1>Console HTML not found</h1></body></html>';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that looks up a session by ID from the server's session pool. */
export type SessionLookup = (sessionId: string) => TuiSession | undefined;

/** Function that returns all retained sessions. */
export type SessionList = () => TuiSession[];

/** Function that closes a session and removes it from the server-owned pool. */
export type SessionClose = (sessionId: string) => Promise<CloseResult | undefined>;

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

function notFound(res: ServerResponse, message = 'Not found'): void {
  json(res, { error: message }, 404);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Create a request handler for the web console routes.
 *
 * The handler is designed to be composed with the MCP `/mcp` endpoint:
 * if a request doesn't match any console route, it returns `false` so
 * the caller can fall through to the MCP handler.
 *
 * @param getSession - Function to look up a session by ID.
 * @param listSessions - Function to list all sessions.
 * @returns A handler function. Returns `true` if the request was handled.
 */
export function createWebConsoleHandler(
  getSession: SessionLookup,
  listSessions: SessionList,
  closeSession: SessionClose
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {

  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Preflight requests have already passed the HTTP server's Host/Origin validation.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return true;
    }

    // Console HTML
    if (path === '/' && method === 'GET') {
      html(res, consoleHtml);
      return true;
    }

    // List sessions
    if (path === '/api/sessions' && method === 'GET') {
      const sessions = listSessions().map(s => s.info);
      json(res, { sessions });
      return true;
    }

    // Session-specific routes: /api/sessions/:id/...
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)\/(.+)$/);
    if (!sessionMatch) return false;

    const [, sessionId, action] = sessionMatch;
    if (!sessionId || !action) return false;

    const session = getSession(sessionId);
    if (!session) {
      notFound(res, `Session not found: ${sessionId}`);
      return true;
    }

    // GET /api/sessions/:id/screen
    if (action === 'screen' && method === 'GET') {
      const screen = session.readScreen();
      json(res, { screen });
      return true;
    }

    // GET /api/sessions/:id/screen-rich
    if (action === 'screen-rich' && method === 'GET') {
      const richLines = session.readScreenRich();
      const { cols, rows } = session.info.dimensions;
      json(res, { richLines, dimensions: { cols, rows } });
      return true;
    }

    // POST /api/sessions/:id/keys
    if (action === 'keys' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (body.keys) {
          await session.sendKeys(body.keys);
        } else if (body.specialKey) {
          const key = body.specialKey as string;
          if (SPECIAL_KEY_VALUES.includes(key as SpecialKey)) {
            await session.sendSpecialKey(key as SpecialKey);
          } else {
            json(res, { error: `Unknown special key: ${key}` }, 400);
            return true;
          }
        } else {
          json(res, { error: 'Provide keys or specialKey' }, 400);
          return true;
        }
        const screen = session.readScreen();
        json(res, { screen });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return true;
    }

    // GET /api/sessions/:id/screenshot
    if (action === 'screenshot' && method === 'GET') {
      try {
        const svg = session.screenshot();
        json(res, { svg });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return true;
    }

    // POST /api/sessions/:id/close
    if (action === 'close' && method === 'POST') {
      try {
        const result = await closeSession(sessionId);
        if (!result) {
          notFound(res, `Session not found: ${sessionId}`);
          return true;
        }
        json(res, { exitCode: result.exitCode, signal: result.signal });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return true;
    }

    return false;
  };
}

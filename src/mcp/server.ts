/**
 * MCP server for the TUI harness.
 *
 * Creates and configures an MCP Server instance that exposes eight tools for
 * interacting with TUI applications through headless pseudo-terminals:
 *
 *   tui_launch        - Spawn a TUI process in a PTY
 *   tui_send_keys     - Send keystrokes (text or special keys)
 *   tui_action        - Composite: send keys, wait for pattern, read screen
 *   tui_read_screen   - Read the current terminal screen
 *   tui_wait_for      - Wait for a pattern to appear on screen
 *   tui_screenshot    - Capture a bordered, numbered screenshot (text or SVG)
 *   tui_close         - Close a session and terminate its process
 *   tui_list_sessions - List retained sessions and their current liveness
 */
import {
  DARK_THEME,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  LIGHT_THEME,
  LaunchError,
  TuiSession,
  WaitForTimeoutError,
  closeAll,
} from '../index.js';
import type { CloseResult, SpecialKey, SvgRenderOptions } from '../index.js';
import { LAUNCH_DEFAULTS, SPECIAL_KEY_ENUM, TOOL_NAMES } from './tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync } from 'fs';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of concurrent TUI sessions the server will manage. */
const MAX_SESSIONS = 10;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Active TUI sessions keyed by session ID. */
const sessions = new Map<string, TuiSession>();

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function jsonResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

function getSession(sessionId: string): TuiSession | undefined {
  return sessions.get(sessionId);
}

function activeSessionCount(): number {
  return Array.from(sessions.values()).filter(session => session.alive).length;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleLaunch(args: {
  command?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}) {
  if (activeSessionCount() >= MAX_SESSIONS) {
    return errorResponse(
      `Maximum number of concurrent sessions (${MAX_SESSIONS}) reached. ` +
        'Close an existing session before launching a new one.'
    );
  }

  const command = args.command ?? LAUNCH_DEFAULTS.command;
  const commandArgs = args.args ?? [...LAUNCH_DEFAULTS.args];

  try {
    const session = await TuiSession.launch({
      command,
      args: commandArgs,
      cwd: args.cwd,
      cols: args.cols,
      rows: args.rows,
      env: args.env,
    });

    sessions.set(session.sessionId, session);

    const screen = session.readScreen();
    const { sessionId } = session;
    const { pid, dimensions } = session.info;

    return jsonResponse({ sessionId, pid, dimensions, screen });
  } catch (err) {
    if (err instanceof LaunchError) {
      return errorResponse(
        `Launch failed: ${err.message}\n` +
          `Command: ${err.command} ${err.args.join(' ')}\n` +
          `CWD: ${err.cwd}\n` +
          `Exit code: ${err.exitCode}`
      );
    }
    throw err;
  }
}

async function handleSendKeys(args: { sessionId: string; keys?: string; specialKey?: SpecialKey; waitMs?: number }) {
  const { sessionId } = args;
  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${sessionId}`);
  }

  const { keys, specialKey, waitMs } = args;

  if (!keys && !specialKey) {
    return errorResponse('Either keys or specialKey must be provided.');
  }
  if (keys && specialKey) {
    return errorResponse('Provide either keys or specialKey, not both.');
  }

  try {
    let result;
    if (keys !== undefined) {
      result = await session.sendKeys(keys, waitMs);
    } else {
      result = await session.sendSpecialKey(specialKey!, waitMs);
    }
    return jsonResponse({ screen: result.screen, settled: result.settled });
  } catch (err) {
    return errorResponse(
      `Failed to send keys to session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleAction(args: {
  sessionId: string;
  keys?: string;
  specialKey?: SpecialKey;
  waitMs?: number;
  pattern?: string;
  timeoutMs?: number;
  isRegex?: boolean;
  numbered?: boolean;
  includeScrollback?: boolean;
}) {
  const { sessionId } = args;
  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${sessionId}`);
  }

  const { keys, specialKey, waitMs, pattern, timeoutMs, isRegex, numbered, includeScrollback } = args;

  if (!keys && !specialKey && !pattern) {
    return errorResponse('At least one of keys, specialKey, or pattern must be provided.');
  }

  if (keys && specialKey) {
    return errorResponse('Provide either keys or specialKey, not both.');
  }

  try {
    let settled: boolean | undefined;

    // Step 1: Send keys (if provided).
    if (keys !== undefined) {
      const result = await session.sendKeys(keys, waitMs);
      settled = result.settled;
    } else if (specialKey !== undefined) {
      const result = await session.sendSpecialKey(specialKey, waitMs);
      settled = result.settled;
    }

    // Step 2: Wait for pattern (if provided).
    let found: boolean | undefined;
    let elapsed: number | undefined;

    if (pattern !== undefined) {
      let resolvedPattern: string | RegExp;
      if (isRegex) {
        try {
          resolvedPattern = new RegExp(pattern);
        } catch (err) {
          return errorResponse(
            `Invalid regex pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        resolvedPattern = pattern;
      }

      const start = Date.now();
      try {
        await session.waitFor(resolvedPattern, timeoutMs);
        found = true;
        elapsed = Date.now() - start;
      } catch (err) {
        if (err instanceof WaitForTimeoutError) {
          found = false;
          elapsed = err.elapsed;
        } else {
          throw err;
        }
      }
    }

    // Step 3: Read final screen state.
    const screen = session.readScreen({ numbered, includeScrollback });

    const response: Record<string, unknown> = { screen };
    if (settled !== undefined) {
      response.settled = settled;
    }
    if (found !== undefined) {
      response.found = found;
      response.elapsed = elapsed;
    }

    return jsonResponse(response);
  } catch (err) {
    return errorResponse(`Action failed on session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleReadScreen(args: { sessionId: string; includeScrollback?: boolean; numbered?: boolean }) {
  const { sessionId } = args;
  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${sessionId}`);
  }

  try {
    const screen = session.readScreen({
      includeScrollback: args.includeScrollback,
      numbered: args.numbered,
    });

    return jsonResponse({ screen });
  } catch (err) {
    return errorResponse(
      `Failed to read screen for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleWaitFor(args: { sessionId: string; pattern: string; timeoutMs?: number; isRegex?: boolean }) {
  const { sessionId } = args;
  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${sessionId}`);
  }

  const { isRegex, timeoutMs } = args;
  const patternStr = args.pattern;

  let pattern: string | RegExp;
  if (isRegex) {
    try {
      pattern = new RegExp(patternStr);
    } catch (err) {
      return errorResponse(
        `Invalid regex pattern "${patternStr}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    pattern = patternStr;
  }

  const start = Date.now();

  try {
    const screen = await session.waitFor(pattern, timeoutMs);
    const elapsed = Date.now() - start;
    return jsonResponse({ found: true, elapsed, screen });
  } catch (err) {
    if (err instanceof WaitForTimeoutError) {
      return jsonResponse({
        found: false,
        elapsed: err.elapsed,
        screen: err.screen,
      });
    }
    return errorResponse(
      `Error waiting for pattern in session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function handleScreenshot(args: {
  sessionId: string;
  format?: 'text' | 'svg' | 'png';
  theme?: 'dark' | 'light';
  fontSize?: number;
  showWindowChrome?: boolean;
  title?: string;
  savePath?: string;
  returnContent?: boolean;
}) {
  const { sessionId } = args;
  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${sessionId}`);
  }

  const format = args.format ?? 'text';

  try {
    const screen = session.readScreen({ numbered: format === 'text' });
    const { dimensions, cursor, bufferType } = screen;
    const metadata = {
      cursor,
      dimensions,
      bufferType,
      timestamp: new Date().toISOString(),
    };

    const svgOptions: SvgRenderOptions = {
      theme: args.theme === 'light' ? LIGHT_THEME : DARK_THEME,
      fontSize: args.fontSize,
      showWindowChrome: args.showWindowChrome,
      title: args.title,
    };

    if (format === 'svg') {
      const svg = session.screenshot(svgOptions);

      if (args.savePath) {
        writeFileSync(args.savePath, svg, 'utf-8');
      }

      const includeContent = args.returnContent !== false;

      return jsonResponse({
        format: 'svg',
        ...(includeContent ? { svg } : {}),
        ...(args.savePath ? { savePath: args.savePath } : {}),
        metadata,
      });
    }

    if (format === 'png') {
      const image = session.screenshotPng(svgOptions);
      if (args.savePath) {
        writeFileSync(args.savePath, image.png);
      }

      const result = {
        format: 'png',
        ...(args.savePath ? { savePath: args.savePath } : {}),
        metadata: {
          ...metadata,
          pixels: { width: image.width, height: image.height },
        },
      };
      const includeContent = args.returnContent !== false;

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ...(includeContent
            ? [
                {
                  type: 'image' as const,
                  data: Buffer.from(image.png).toString('base64'),
                  mimeType: 'image/png',
                },
              ]
            : []),
        ],
      };
    }

    // Default: text format
    const header = `TUI Screenshot (${dimensions.cols}x${dimensions.rows})`;
    const topBorder = `\u250C\u2500 ${header} ${'\u2500'.repeat(Math.max(0, dimensions.cols - header.length - 4))}\u2510`;
    const bottomBorder = `\u2514${'\u2500'.repeat(Math.max(0, dimensions.cols + 2))}\u2518`;

    const body = screen.lines.map(line => ` ${line}`).join('\n');

    const screenshot = `${topBorder}\n${body}\n${bottomBorder}`;

    if (args.savePath) {
      writeFileSync(args.savePath, screenshot, 'utf-8');
    }

    const includeContent = args.returnContent !== false;

    return jsonResponse({
      format: 'text',
      ...(includeContent ? { screenshot } : {}),
      ...(args.savePath ? { savePath: args.savePath } : {}),
      metadata,
    });
  } catch (err) {
    return errorResponse(
      `Failed to capture screenshot for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleClose(args: { sessionId: string; signal?: string }) {
  const { sessionId } = args;
  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${sessionId}`);
  }

  try {
    const { signal } = args;
    const result = await closeTuiSession(sessionId, signal);
    if (!result) {
      return errorResponse(`Session not found: ${sessionId}`);
    }

    return jsonResponse({
      exitCode: result.exitCode,
      signal: result.signal,
      finalScreen: result.finalScreen,
    });
  } catch (err) {
    return errorResponse(`Error closing session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleListSessions() {
  const sessionList = Array.from(sessions.values()).map(session => session.info);
  return jsonResponse({ sessions: sessionList });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and configure an MCP Server instance with all TUI harness tools
 * registered.
 *
 * The returned server is fully configured but not yet connected to a transport.
 * Call `server.connect(transport)` to start serving requests.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'tui-harness', version: '1.0.0' },
    {
      instructions:
        'This server provides tools for driving TUI applications via headless pseudo-terminals. ' +
        'For multi-step TUI flows, use the "tui-flow-executor" Claude Code agent (model: haiku) which ' +
        'drives these tools autonomously, validates each step, captures screenshots on screen changes, ' +
        'and produces a markdown report. Install it with: npx tui-harness-mcp install-agent',
    }
  );

  // --- tui_launch ---
  server.registerTool(
    TOOL_NAMES.LAUNCH,
    {
      title: 'Launch TUI',
      description:
        'Launch a TUI application in a pseudo-terminal. Returns session ID and initial screen state. ' +
        'Defaults to launching a bash shell if no command is specified.',
      inputSchema: {
        command: z
          .string()
          .optional()
          .describe('The executable to spawn (e.g. "vim", "htop", "python"). Defaults to "bash".'),
        args: z
          .array(z.string())
          .optional()
          .describe('Arguments passed to the command.'),
        cwd: z.string().optional().describe('Working directory for the spawned process.'),
        cols: z
          .number()
          .int()
          .min(40)
          .max(300)
          .optional()
          .describe(`Terminal width in columns (default: ${DEFAULT_TERMINAL_COLS}).`),
        rows: z
          .number()
          .int()
          .min(10)
          .max(100)
          .optional()
          .describe(`Terminal height in rows (default: ${DEFAULT_TERMINAL_ROWS}).`),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe('Additional environment variables merged with the default environment.'),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async args => {
      return await handleLaunch(args);
    }
  );

  // --- tui_send_keys ---
  server.registerTool(
    TOOL_NAMES.SEND_KEYS,
    {
      title: 'Send Keys',
      description: 'Send keystrokes to a TUI session. Returns updated screen state after rendering settles.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        keys: z
          .string()
          .optional()
          .describe('Raw text to type into the terminal. For special keys, use the specialKey parameter instead.'),
        specialKey: z
          .enum(SPECIAL_KEY_ENUM)
          .optional()
          .describe(
            'A named special key to send (e.g. "enter", "tab", "ctrl+c", "f1"). Mutually exclusive with keys.'
          ),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Milliseconds of text silence required for the screen to settle (default: 100).'),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async args => {
      return await handleSendKeys(args);
    }
  );

  // --- tui_action ---
  server.registerTool(
    TOOL_NAMES.ACTION,
    {
      title: 'Perform Action',
      description:
        'Composite tool: send keys, wait for a pattern, and read screen -- all in one call. ' +
        'Eliminates round-trips between separate tui_send_keys, tui_wait_for, and tui_read_screen calls. ' +
        'At least one of keys, specialKey, or pattern must be provided.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        keys: z.string().optional().describe('Raw text to type into the terminal. Mutually exclusive with specialKey.'),
        specialKey: z
          .enum(SPECIAL_KEY_ENUM)
          .optional()
          .describe('A named special key to send (e.g. "enter", "tab", "ctrl+c"). Mutually exclusive with keys.'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Milliseconds of text silence required for the screen to settle (default: 100).'),
        pattern: z.string().optional().describe('Text or regex pattern to wait for on screen after sending keys.'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30000)
          .optional()
          .describe('Maximum time to wait for the pattern in milliseconds (default: 10000).'),
        isRegex: z.boolean().optional().describe('When true, interpret the pattern as a regular expression.'),
        numbered: z.boolean().optional().describe('When true, prefix each screen line with its 1-indexed line number.'),
        includeScrollback: z
          .boolean()
          .optional()
          .describe('When true, include scrollback history in the screen output.'),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async args => {
      return await handleAction(args);
    }
  );

  // --- tui_read_screen ---
  server.registerTool(
    TOOL_NAMES.READ_SCREEN,
    {
      title: 'Read Screen',
      description: 'Read the current terminal screen state. Safe read-only operation.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        includeScrollback: z
          .boolean()
          .optional()
          .describe('When true, include lines above the visible viewport (scrollback history).'),
        numbered: z.boolean().optional().describe('When true, prefix each line with its 1-indexed line number.'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    args => {
      return handleReadScreen(args);
    }
  );

  // --- tui_wait_for ---
  server.registerTool(
    TOOL_NAMES.WAIT_FOR,
    {
      title: 'Wait For Pattern',
      description:
        'Wait for a text pattern to appear on the terminal screen. Useful for synchronizing with async TUI operations.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        pattern: z
          .string()
          .describe(
            'The text or regex pattern to search for on screen. Interpreted as a plain substring unless isRegex is true.'
          ),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30000)
          .optional()
          .describe('Maximum time in milliseconds to wait for the pattern to appear (default: 10000).'),
        isRegex: z.boolean().optional().describe('When true, interpret the pattern as a regular expression.'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async args => {
      return await handleWaitFor(args);
    }
  );

  // --- tui_screenshot ---
  server.registerTool(
    TOOL_NAMES.SCREENSHOT,
    {
      title: 'Take Screenshot',
      description:
        'Capture a screenshot of the terminal. Supports text, self-contained SVG, and deterministic PNG output. ' +
        'Optionally writes the output to disk.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        format: z
          .enum(['text', 'svg', 'png'])
          .optional()
          .describe(
            'Output format. "text" returns bordered text, "svg" returns a self-contained vector image, and "png" returns a raster image (default: "text").'
          ),
        theme: z
          .enum(['dark', 'light'])
          .optional()
          .describe('Color theme for SVG and PNG rendering. Ignored when format is "text" (default: "dark").'),
        fontSize: z
          .number()
          .min(8)
          .max(48)
          .optional()
          .describe('Terminal font size in pixels for SVG and PNG rendering (default: 16).'),
        showWindowChrome: z
          .boolean()
          .optional()
          .describe('Whether SVG and PNG output includes terminal window chrome (default: true).'),
        title: z
          .string()
          .max(200)
          .optional()
          .describe('Optional title shown in terminal window chrome.'),
        savePath: z
          .string()
          .optional()
          .describe(
            'Absolute file path to write the screenshot content to disk. Existing files are overwritten in UTF-8 encoding.'
          ),
        returnContent: z
          .boolean()
          .optional()
          .describe(
            'Whether to return the screenshot content in the response (default: true). Set to false when savePath is provided to avoid returning large SVG/text content to the model.'
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    args => {
      return handleScreenshot(args);
    }
  );

  // --- tui_close ---
  server.registerTool(
    TOOL_NAMES.CLOSE,
    {
      title: 'Close Session',
      description: 'Close a TUI session and terminate the process.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        signal: z
          .enum(['SIGTERM', 'SIGKILL', 'SIGHUP'])
          .optional()
          .describe('The signal to send to the process (default: SIGTERM).'),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async args => {
      return await handleClose(args);
    }
  );

  // --- tui_list_sessions ---
  server.registerTool(
    TOOL_NAMES.LIST_SESSIONS,
    {
      title: 'List Sessions',
      description: 'List retained TUI sessions and their current liveness.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    () => {
      return handleListSessions();
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Session pool access (for web console)
// ---------------------------------------------------------------------------

/** Look up a TUI session by ID. Used by the web console. */
export function getTuiSession(sessionId: string): TuiSession | undefined {
  return sessions.get(sessionId);
}

/** List retained TUI sessions. Used by the web console. */
export function listTuiSessions(): TuiSession[] {
  return Array.from(sessions.values());
}

/** Close and remove a TUI session from the server-owned session pool. */
export async function closeTuiSession(sessionId: string, signal?: string): Promise<CloseResult | undefined> {
  const session = sessions.get(sessionId);
  if (!session) {
    return undefined;
  }

  try {
    return await session.close(signal);
  } finally {
    sessions.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Close all retained sessions managed by this server and clear the session map.
 */
export async function closeAllSessions(): Promise<void> {
  const closePromises = Array.from(sessions.values()).map(async session => {
    try {
      await session.close();
    } catch {
      // Best-effort cleanup
    }
  });

  await Promise.allSettled(closePromises);
  sessions.clear();

  await closeAll();
}

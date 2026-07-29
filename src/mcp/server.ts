/**
 * MCP server for the TUI harness.
 *
 * Creates and configures an MCP Server instance that exposes tools for
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
 *   tui_record_start  - Start a demo recording
 *   tui_record_mark   - Add a timed caption or narration cue
 *   tui_record_stop   - Stop and save a recording artifact
 *   tui_demo_render   - Render a recording artifact to MP4 or WebM
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
  renderDemo,
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
  if (session.demoRecordingStatus?.active) {
    return errorResponse(
      `Session ${sessionId} has an active demo recording. Save it with tui_record_stop before closing the session.`
    );
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

function handleRecordStart(args: { sessionId: string; captureInput?: boolean }) {
  const session = getSession(args.sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${args.sessionId}`);
  }

  try {
    return jsonResponse({
      sessionId: args.sessionId,
      recording: session.startDemoRecording({ captureInput: args.captureInput }),
    });
  } catch (err) {
    return errorResponse(
      `Failed to start recording session ${args.sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function handleRecordMark(args: {
  sessionId: string;
  label?: string;
  caption?: string;
  narration?: string;
  audioPath?: string;
  holdMs?: number;
}) {
  const session = getSession(args.sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${args.sessionId}`);
  }

  try {
    const marker = session.markDemoRecording({
      label: args.label,
      caption: args.caption,
      narration: args.narration,
      audioPath: args.audioPath,
      holdMs: args.holdMs,
    });
    return jsonResponse({ sessionId: args.sessionId, marker });
  } catch (err) {
    return errorResponse(
      `Failed to mark recording for session ${args.sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleRecordStop(args: { sessionId: string; savePath: string }) {
  const session = getSession(args.sessionId);
  if (!session) {
    return errorResponse(`Session not found: ${args.sessionId}`);
  }

  try {
    return jsonResponse(await session.stopDemoRecording(args.savePath));
  } catch (err) {
    return errorResponse(
      `Failed to stop recording session ${args.sessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleDemoRender(args: {
  recordingPath: string;
  outputPath: string;
  format?: 'mp4' | 'webm';
  renderer?: 'native' | 'mac';
  fps?: number;
  theme?: 'dark' | 'light';
  title?: string;
  fontSize?: number;
  tailHoldMs?: number;
  captions?: boolean;
  pollyVoiceId?: string;
  pollyEngine?: 'standard' | 'neural' | 'long-form' | 'generative';
  awsProfile?: string;
  awsRegion?: string;
  narrationOutputPath?: string;
  macPath?: string;
  macTransition?: 'crossfade' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'wipe' | 'fadeBlack' | 'zoom';
  macTransitionMs?: number;
  macEasing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  macCaptionFontSize?: number;
  macNarrationPaddingMs?: number;
  macProgramFileName?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  keepWorkDir?: boolean;
  workDir?: string;
}) {
  try {
    const result = await renderDemo({
      recording: args.recordingPath,
      outputPath: args.outputPath,
      format: args.format,
      renderer: args.renderer,
      fps: args.fps,
      theme: args.theme,
      title: args.title,
      fontSize: args.fontSize,
      tailHoldMs: args.tailHoldMs,
      captions: args.captions,
      ...(args.pollyVoiceId
        ? {
            polly: {
              voiceId: args.pollyVoiceId,
              engine: args.pollyEngine,
              profile: args.awsProfile,
              region: args.awsRegion,
            },
          }
        : {}),
      ...(args.renderer === 'mac'
        ? {
            mac: {
              executablePath: args.macPath,
              transition: args.macTransition,
              transitionMs: args.macTransitionMs,
              easing: args.macEasing,
              captionFontSize: args.macCaptionFontSize,
              narrationPaddingMs: args.macNarrationPaddingMs,
              programFileName: args.macProgramFileName,
            },
          }
        : {}),
      ffmpegPath: args.ffmpegPath,
      ffprobePath: args.ffprobePath,
      narrationOutputPath: args.narrationOutputPath,
      keepWorkDir: args.keepWorkDir,
      workDir: args.workDir,
    });
    return jsonResponse(result);
  } catch (err) {
    return errorResponse(`Failed to render TUI demo: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    { name: 'tui-harness', version: '0.3.0' },
    {
      instructions:
        'This server provides tools for driving TUI applications via headless pseudo-terminals. ' +
        'It can record sessions and render polished captioned or narrated demo videos. ' +
        'For multi-step TUI flows, use the "tui-flow-executor" Claude Code agent (model: haiku) which ' +
        'drives these tools autonomously, validates each step, captures screenshots on screen changes, ' +
        'and can produce walkthrough videos. Install the agent and video skill with: npx tui-harness-mcp install-all',
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

  // --- tui_record_start ---
  server.registerTool(
    TOOL_NAMES.RECORD_START,
    {
      title: 'Start Demo Recording',
      description:
        'Start recording timestamped PTY output for a session. The settled initial screen is included. ' +
        'Typed input is excluded by default to avoid capturing secrets.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        captureInput: z
          .boolean()
          .optional()
          .describe('Record raw typed input for documentation purposes (default: false). May capture secrets.'),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    args => handleRecordStart(args)
  );

  // --- tui_record_mark ---
  server.registerTool(
    TOOL_NAMES.RECORD_MARK,
    {
      title: 'Mark Demo Recording',
      description:
        'Add a semantic cue to an active recording. Cues can label a step, show a caption, synthesize narration, ' +
        'use an existing audio file, and hold the current screen for a requested duration.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        label: z.string().max(200).optional().describe('Short internal name for this walkthrough step.'),
        caption: z.string().max(2000).optional().describe('Text rendered visibly below the terminal.'),
        narration: z
          .string()
          .max(3000)
          .optional()
          .describe('Narration script. Also used as the caption when caption is omitted.'),
        audioPath: z
          .string()
          .optional()
          .describe('Existing narration audio file. Takes precedence over synthesized narration for this marker.'),
        holdMs: z
          .number()
          .int()
          .min(0)
          .max(120000)
          .optional()
          .describe('Minimum time to freeze the marked screen during rendering (default: 0).'),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    args => handleRecordMark(args)
  );

  // --- tui_record_stop ---
  server.registerTool(
    TOOL_NAMES.RECORD_STOP,
    {
      title: 'Stop Demo Recording',
      description: 'Stop an active recording and save its versioned JSON artifact to disk.',
      inputSchema: {
        sessionId: z.string().describe('The session ID returned by tui_launch.'),
        savePath: z
          .string()
          .describe('Path for the recording JSON. Parent directories are created and an existing file is overwritten.'),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async args => await handleRecordStop(args)
  );

  // --- tui_demo_render ---
  server.registerTool(
    TOOL_NAMES.DEMO_RENDER,
    {
      title: 'Render TUI Demo Video',
      description:
        'Render a recording as a captioned MP4 or WebM. The native renderer preserves full motion; the Mac renderer ' +
        'uses semantic keyframes and makes Mac (Meme as Code) own scene composition, timing, captions, and transitions. ' +
        'Uses FFmpeg and ffprobe. ' +
        'When pollyVoiceId is set, narration text is synthesized with Amazon Polly through the AWS CLI.',
      inputSchema: {
        recordingPath: z.string().describe('Path to a recording JSON created by tui_record_stop.'),
        outputPath: z.string().describe('Destination .mp4 or .webm path. Parent directories are created.'),
        format: z.enum(['mp4', 'webm']).optional().describe('Video container; inferred from outputPath by default.'),
        renderer: z
          .enum(['native', 'mac'])
          .optional()
          .describe('Visual renderer. Native preserves full motion; Mac composes marked semantic scenes (default: native).'),
        fps: z.number().int().min(1).max(60).optional().describe('Output frame rate (default: 30).'),
        theme: z.enum(['dark', 'light']).optional().describe('Terminal color theme (default: dark).'),
        title: z.string().max(200).optional().describe('Window title shown in the rendered terminal chrome.'),
        fontSize: z.number().min(8).max(48).optional().describe('Terminal font size in pixels (default: 16).'),
        tailHoldMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe('Time to hold the final screen (default: 1000).'),
        captions: z.boolean().optional().describe('Render captions and write a sidecar SRT file (default: true).'),
        pollyVoiceId: z
          .string()
          .optional()
          .describe('Amazon Polly voice ID. When omitted, narration text remains caption-only.'),
        pollyEngine: z.enum(['standard', 'neural', 'long-form', 'generative']).optional(),
        awsProfile: z.string().optional().describe('AWS CLI profile used for Polly synthesis.'),
        awsRegion: z.string().optional().describe('AWS region used for Polly synthesis.'),
        narrationOutputPath: z
          .string()
          .optional()
          .describe('Optional .wav, .mp3, or .m4a path for the assembled loudness-normalized narration track.'),
        macPath: z
          .string()
          .optional()
          .describe('Mac (Meme as Code) executable path when renderer is mac (default: mac from PATH).'),
        macTransition: z
          .enum(['crossfade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'wipe', 'fadeBlack', 'zoom'])
          .optional()
          .describe('Transition between Mac semantic scenes (default: crossfade).'),
        macTransitionMs: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe('Requested Mac transition duration in milliseconds (default: 500).'),
        macEasing: z
          .enum(['linear', 'easeIn', 'easeOut', 'easeInOut'])
          .optional()
          .describe('Mac transition easing (default: easeInOut).'),
        macCaptionFontSize: z
          .number()
          .min(10)
          .max(96)
          .optional()
          .describe('Mac caption font size in pixels (default: 24).'),
        macNarrationPaddingMs: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Silence retained after each narration clip in Mac scenes (default: 300).'),
        macProgramFileName: z
          .string()
          .optional()
          .describe('Plain .mac filename generated in workDir (default: demo.mac).'),
        ffmpegPath: z.string().optional().describe('FFmpeg executable path (default: ffmpeg from PATH).'),
        ffprobePath: z.string().optional().describe('ffprobe executable path (default: ffprobe from PATH).'),
        keepWorkDir: z
          .boolean()
          .optional()
          .describe('Retain generated frames, narration, and Mac source artifacts for inspection.'),
        workDir: z
          .string()
          .optional()
          .describe('Specific work directory. Use a durable path to preserve generated Mac source and its manifest.'),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async args => await handleDemoRender(args)
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

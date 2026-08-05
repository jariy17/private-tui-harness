/**
 * Core TUI session class for the test harness.
 *
 * Manages the lifecycle of a headless terminal session: spawning a PTY
 * process, piping its output through an xterm terminal emulator, handling
 * DSR (Device Status Report) queries so Ink and other TUI frameworks can
 * detect cursor position, and providing methods to interact with and
 * inspect the terminal screen.
 *
 * Instances are created exclusively through the static {@link TuiSession.launch}
 * factory method. The constructor is private to enforce proper initialization
 * sequencing (PTY spawn, DSR wiring, initial settle).
 */
import { resolveKey } from './key-map.js';
import { buildScreenState, getBufferType, readViewportRich } from './screen.js';
import type { RichLine } from './screen.js';
import { register, unregister } from './session-manager.js';
import { SettlingMonitor } from './settling.js';
import { renderTerminalToPng } from './terminal-rasterizer.js';
import type { RasterizedTerminalImage } from './terminal-rasterizer.js';
import { renderTerminalToSvg } from './svg-renderer.js';
import type { SvgRenderOptions } from './svg-renderer.js';
import { TerminalRecorder } from './video-recorder.js';
import type { RecordingOptions, RecordingResult } from './video-recorder.js';
import type {
  CloseResult,
  LaunchOptions,
  ReadOptions,
  ScreenState,
  SendResult,
  SessionInfo,
  SpecialKey,
} from './types.js';
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  LaunchError,
  WaitForTimeoutError,
} from './types.js';
import xtermHeadless from '@xterm/headless';
import { randomUUID } from 'crypto';
import * as pty from 'node-pty';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/**
 * Map from numeric signal values to POSIX signal names.
 *
 * node-pty reports the termination signal as a number. This map converts
 * the most common signal numbers to their human-readable names.
 */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
};

/**
 * A headless TUI session backed by a PTY process and an xterm terminal emulator.
 *
 * Provides methods to send keystrokes, read the screen, wait for patterns,
 * and cleanly shut down the session. Automatically handles DSR/CPR queries
 * so that TUI frameworks like Ink can detect terminal capabilities without
 * hanging.
 *
 * Create instances via the static {@link TuiSession.launch} factory.
 */
export class TuiSession {
  private readonly _sessionId: string;
  private readonly terminal: Terminal;
  private readonly ptyProcess: pty.IPty;
  private readonly settlingMonitor: SettlingMonitor;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly created: Date;
  private readonly disposables: { dispose(): void }[];
  private _alive: boolean;
  private _exitCode: number | null;
  private _exitSignal: string | null;
  private recorder: TerminalRecorder | null;

  private constructor(
    sessionId: string,
    terminal: Terminal,
    ptyProcess: pty.IPty,
    settlingMonitor: SettlingMonitor,
    command: string,
    args: string[],
    cwd: string,
    created: Date,
    disposables: { dispose(): void }[]
  ) {
    this._sessionId = sessionId;
    this.terminal = terminal;
    this.ptyProcess = ptyProcess;
    this.settlingMonitor = settlingMonitor;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.created = created;
    this.disposables = disposables;
    this._alive = true;
    this._exitCode = null;
    this._exitSignal = null;
    this.recorder = null;
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  /**
   * Launch a new TUI session.
   *
   * Spawns the requested command in a PTY, wires its output through a
   * headless xterm terminal emulator, registers a DSR handler so TUI
   * frameworks can query cursor position, and waits for initial output
   * to settle before returning.
   *
   * @param options - Configuration for the session (command, args, dimensions, etc.)
   * @returns A fully initialized TuiSession ready for interaction.
   * @throws {LaunchError} If the spawned process exits with a non-zero code
   *   before initial output settles.
   */
  static async launch(options: LaunchOptions): Promise<TuiSession> {
    const sessionId = randomUUID();
    const cols = options.cols ?? DEFAULT_TERMINAL_COLS;
    const rows = options.rows ?? DEFAULT_TERMINAL_ROWS;
    const cwd = options.cwd ?? process.cwd();
    const args = options.args ?? [];
    const created = new Date();
    const disposables: { dispose(): void }[] = [];

    // 1. Create the headless terminal emulator.
    const terminal = new Terminal({ cols, rows, allowProposedApi: true });

    // Build the environment. We must DELETE INIT_CWD rather than set it to
    // undefined -- node-pty converts undefined values to the string "undefined",
    // which would cause getWorkingDirectory() to return "undefined" instead
    // of process.cwd().
    const { INIT_CWD: _initCwd, ...cleanEnv } = process.env;

    // 2. Spawn the PTY process.
    const ptyProcess = pty.spawn(options.command, args, {
      cols,
      rows,
      cwd,
      env: { ...cleanEnv, TERM: 'xterm-256color', ...options.env },
    });

    // 3. Wire PTY output into xterm.
    const dataDisposable = ptyProcess.onData((data: string) => {
      terminal.write(data);
    });
    disposables.push(dataDisposable);

    // 4. Register DSR (Device Status Report) handler.
    //
    // TUI frameworks like Ink query cursor position by writing \x1b[6n
    // (CPR request) to stdout. xterm parses this as a CSI sequence with
    // final character 'n'. Our handler intercepts it and writes the
    // cursor position report back into the PTY's stdin, completing the
    // round-trip that the TUI app expects.
    const dsrDisposable = terminal.parser.registerCsiHandler({ final: 'n' }, params => {
      if (params[0] === 6) {
        // CPR: report cursor position as \x1b[{row};{col}R (1-indexed)
        const buf = terminal.buffer.active;
        ptyProcess.write(`\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`);
        return true;
      }
      if (params[0] === 5) {
        // Device status: report OK
        ptyProcess.write('\x1b[0n');
        return true;
      }
      return false;
    });
    disposables.push(dsrDisposable);

    // 5. Create the settling monitor.
    const settlingMonitor = new SettlingMonitor(terminal);

    // 6. Track process exit state.
    let exited = false;
    let earlyExitCode: number | null = null;
    let earlyExitSignal: string | null = null;

    const exitPromise = new Promise<void>(resolve => {
      const exitDisposable = ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        exited = true;
        earlyExitCode = exitCode;
        earlyExitSignal = signal != null && signal > 0 ? (SIGNAL_NAMES[signal] ?? `signal(${signal})`) : null;
        resolve();
      });
      disposables.push(exitDisposable);
    });

    // 7. Create the session instance (private constructor).
    const session = new TuiSession(
      sessionId,
      terminal,
      ptyProcess,
      settlingMonitor,
      options.command,
      args,
      cwd,
      created,
      disposables
    );

    // 8. Race initial settle against process exit.
    const settlePromise = settlingMonitor.waitForSettle(2000);

    await Promise.race([settlePromise, exitPromise]);

    if (exited) {
      // Process exited during initial settle.
      await new Promise<void>(resolve => terminal.write('', resolve));

      if (earlyExitCode !== null && earlyExitCode !== 0) {
        const screen = buildScreenState(terminal);
        terminal.dispose();
        settlingMonitor.dispose();
        throw new LaunchError(options.command, args, cwd, earlyExitCode, screen);
      }

      session._alive = false;
      session._exitCode = earlyExitCode;
      session._exitSignal = earlyExitSignal;
    } else {
      void exitPromise.then(() => {
        session._alive = false;
        session._exitCode = earlyExitCode;
        session._exitSignal = earlyExitSignal;
      });
    }

    // 9. Register with the global session manager.
    register(session);

    return session;
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  /** Whether the PTY process is still running. */
  get alive(): boolean {
    return this._alive;
  }

  /** Unique identifier for this session. */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Metadata about this session. */
  get info(): SessionInfo {
    return {
      sessionId: this._sessionId,
      pid: this.ptyProcess.pid,
      command: this.command,
      cwd: this.cwd,
      dimensions: { cols: this.terminal.cols, rows: this.terminal.rows },
      bufferType: getBufferType(this.terminal),
      alive: this._alive,
      created: this.created,
    };
  }

  // ---------------------------------------------------------------------------
  // Screen reading
  // ---------------------------------------------------------------------------

  /**
   * Read the current terminal screen contents.
   */
  readScreen(options?: ReadOptions): ScreenState {
    return buildScreenState(this.terminal, options);
  }

  /**
   * Read the current terminal screen with full color and style attributes per cell.
   */
  readScreenRich(): RichLine[] {
    return readViewportRich(this.terminal);
  }

  /**
   * Render the current terminal screen as a self-contained SVG string.
   */
  screenshot(options?: SvgRenderOptions): string {
    this.assertAlive();
    return renderTerminalToSvg(this.terminal, options);
  }

  /**
   * Render the current terminal screen as a deterministic PNG image.
   */
  screenshotPng(options?: SvgRenderOptions): RasterizedTerminalImage {
    this.assertAlive();
    return renderTerminalToPng(this.terminal, options);
  }

  // ---------------------------------------------------------------------------
  // Video recording
  // ---------------------------------------------------------------------------

  /** Whether a recording is currently in progress. */
  get recording(): boolean {
    return this.recorder?.recording ?? false;
  }

  /**
   * Start recording the terminal to a video. Captures one frame per distinct
   * screen state until {@link stopRecording} is called.
   *
   * @throws If a recording is already in progress.
   */
  startRecording(options?: RecordingOptions): void {
    this.assertAlive();
    if (this.recorder?.recording) {
      throw new Error(`Session ${this._sessionId} is already recording.`);
    }
    this.recorder = new TerminalRecorder(this.terminal, options);
    this.recorder.start();
  }

  /**
   * Stop recording and encode the captured frames to a video file.
   *
   * @param outputPath - Absolute path to write. Extension selects format
   *   (.gif → GIF, otherwise MP4).
   * @param fps - Output frame rate (default 10).
   * @throws If no recording is in progress.
   */
  async stopRecording(outputPath: string, fps?: number): Promise<RecordingResult> {
    if (!this.recorder?.recording) {
      throw new Error(`Session ${this._sessionId} is not recording.`);
    }
    const recorder = this.recorder;
    this.recorder = null;
    return recorder.stop(outputPath, fps);
  }

  // ---------------------------------------------------------------------------
  // Input methods
  // ---------------------------------------------------------------------------

  /**
   * Send raw keystrokes to the PTY process.
   */
  async sendKeys(keys: string, waitMs?: number): Promise<SendResult> {
    this.assertAlive();
    this.ptyProcess.write(keys);
    const settled = await this.settlingMonitor.waitForSettle(waitMs);
    return { screen: this.readScreen(), settled };
  }

  /**
   * Send a named special key to the PTY process.
   */
  async sendSpecialKey(key: SpecialKey, waitMs?: number): Promise<SendResult> {
    this.assertAlive();
    const sequence = resolveKey(key);
    this.ptyProcess.write(sequence);
    const settled = await this.settlingMonitor.waitForSettle(waitMs);
    return { screen: this.readScreen(), settled };
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  /**
   * Wait for a pattern to appear on the terminal screen.
   *
   * @param pattern - A string (checked with `includes`) or RegExp to match
   *   against the joined screen lines.
   * @param timeoutMs - Maximum wait time in milliseconds. Defaults to 10000.
   * @returns The screen state at the moment the pattern was matched.
   * @throws {WaitForTimeoutError} If the pattern is not found within the timeout.
   */
  async waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<ScreenState> {
    const effectiveTimeout = timeoutMs ?? 10000;

    const matches = (screen: ScreenState): boolean => {
      const text = screen.lines.join('\n');
      return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
    };

    // Check immediately
    const immediateScreen = this.readScreen();
    if (matches(immediateScreen)) {
      return immediateScreen;
    }

    this.assertAlive();

    const start = Date.now();

    return new Promise<ScreenState>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        writeListener.dispose();
        exitListener.dispose();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
      };

      const check = (): boolean => {
        if (settled) return false;
        const screen = this.readScreen();
        if (matches(screen)) {
          cleanup();
          resolve(screen);
          return true;
        }
        return false;
      };

      const writeListener = this.terminal.onWriteParsed(() => {
        check();
      });

      const exitListener = this.ptyProcess.onExit(() => {
        if (settled) return;
        setTimeout(() => {
          if (settled) return;
          if (!check()) {
            cleanup();
            const elapsed = Date.now() - start;
            const currentScreen = this.readScreen();
            reject(new WaitForTimeoutError(pattern, elapsed, currentScreen));
          }
        }, 50);
      });

      const pollTimer = setInterval(() => {
        check();
      }, 100);

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        const elapsed = Date.now() - start;
        const currentScreen = this.readScreen();
        reject(new WaitForTimeoutError(pattern, elapsed, currentScreen));
      }, effectiveTimeout);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Close the session, terminating the PTY process and cleaning up resources.
   */
  async close(signal?: string): Promise<CloseResult> {
    if (!this._alive) {
      const finalScreen = this.readScreen();
      this.disposeAll();
      unregister(this._sessionId);
      return {
        exitCode: this._exitCode,
        signal: this._exitSignal,
        finalScreen,
      };
    }

    const finalScreen = this.readScreen();
    this.ptyProcess.kill(signal ?? 'SIGTERM');

    const exitedCleanly = await this.waitForExit(5000);

    if (!exitedCleanly && this._alive) {
      this.ptyProcess.kill('SIGKILL');
      await this.waitForExit(5000);
    }

    this.disposeAll();
    unregister(this._sessionId);

    return {
      exitCode: this._exitCode,
      signal: this._exitSignal,
      finalScreen,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private assertAlive(): void {
    if (!this._alive) {
      throw new Error(
        `Session ${this._sessionId} is not alive: ${this.command} ${this.args.join(' ')} (exitCode: ${this._exitCode})`
      );
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this._alive) return Promise.resolve(true);

    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        listener.dispose();
        resolve(false);
      }, timeoutMs);

      const listener = this.ptyProcess.onExit(() => {
        clearTimeout(timer);
        listener.dispose();
        resolve(true);
      });
    });
  }

  private disposeAll(): void {
    this.recorder?.dispose();
    this.recorder = null;
    this.settlingMonitor.dispose();
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Best-effort cleanup
      }
    }
    this.terminal.dispose();
  }
}

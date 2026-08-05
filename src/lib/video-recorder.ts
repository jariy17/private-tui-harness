/**
 * Terminal session video recording.
 *
 * The harness already renders any terminal state to a deterministic PNG
 * (see terminal-rasterizer). This module turns a *sequence* of those PNGs
 * into a real video (MP4/GIF).
 *
 * Capture is frame-per-screen-change, not real-time sampling: a headless
 * harness driven by an agent has multi-second wall-clock gaps between
 * keystrokes (model latency), so real-time video would be mostly dead air.
 * We hook `onWriteParsed`, debounce it, drop cosmetic writes (cursor blink)
 * via the same text-snapshot trick SettlingMonitor uses, and capture one
 * frame per distinct screen state along with the wall-clock time it appeared.
 * At encode time each frame's on-screen duration is the gap until the next
 * frame, clamped so long idle gaps don't become dead air.
 */
import { renderTerminalToPng } from './terminal-rasterizer.js';
import type { SvgRenderOptions } from './svg-renderer.js';
import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import xtermHeadless from '@xterm/headless';

const execFileAsync = promisify(execFile);

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/** Debounce window: a frame is captured once the screen is silent this long. */
const DEFAULT_DEBOUNCE_MS = 120;
/** Clamp on per-frame display time so agent-latency gaps don't stall the video. */
const MIN_FRAME_SEC = 0.1;
const MAX_FRAME_SEC = 3;
/** How long the final frame lingers before the video ends. */
const TAIL_FRAME_SEC = 1.5;

interface Frame {
  png: Uint8Array;
  /** performance.now() timestamp (ms) when this frame appeared. */
  atMs: number;
}

export type VideoFormat = 'mp4' | 'gif';

export interface RecordingOptions extends SvgRenderOptions {
  /** ms of screen silence before a changed screen is captured (default 120). */
  debounceMs?: number;
}

export interface RecordingResult {
  outputPath: string;
  format: VideoFormat;
  frameCount: number;
  durationMs: number;
}

/**
 * Records a terminal to a sequence of PNG frames, then encodes them to video.
 *
 * One recorder is attached to one terminal via {@link start}. Frames are held
 * in memory (they compress well and there are few of them — one per screen
 * change), then written to a temp dir and encoded on {@link stop}.
 */
export class TerminalRecorder {
  private readonly terminal: Terminal;
  private readonly options: RecordingOptions;
  private readonly debounceMs: number;
  private readonly frames: Frame[] = [];
  private started = false;
  private lastSnapshot = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private writeListener: { dispose(): void } | null = null;
  private pendingKey = '';

  constructor(terminal: Terminal, options: RecordingOptions = {}) {
    this.terminal = terminal;
    this.options = options;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Whether this recorder is currently capturing frames. */
  get recording(): boolean {
    return this.started;
  }

  /**
   * Record the key label to stamp on the next captured frame. Called by the
   * session just before writing a keystroke to the PTY, so the frame showing
   * the resulting screen is tagged with the key that produced it.
   */
  noteKey(label: string): void {
    this.pendingKey = label;
  }

  /**
   * Begin capturing frames. Captures the current screen as frame 0, then one
   * frame per subsequent distinct screen state.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastSnapshot = this.snapshot();
    this.captureFrame(performance.now());

    this.writeListener = this.terminal.onWriteParsed(() => {
      const snap = this.snapshot();
      if (snap === this.lastSnapshot) return; // cosmetic write (cursor blink)
      this.lastSnapshot = snap;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.captureFrame(performance.now());
      }, this.debounceMs);
    });
  }

  /**
   * Stop capturing and encode the collected frames to a video file.
   *
   * @param outputPath - Absolute path to write. Extension selects format
   *   (.gif → GIF, anything else → MP4).
   * @param fps - Output frame rate (default 10).
   */
  async stop(outputPath: string, fps = 10): Promise<RecordingResult> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.writeListener?.dispose();
    this.writeListener = null;

    // Capture a final frame so the last screen state is always present.
    if (this.started) this.captureFrame(performance.now());

    const frames = this.frames.slice();
    this.started = false;
    this.frames.length = 0;

    if (frames.length === 0) {
      throw new Error('No frames were captured; nothing to encode.');
    }

    const format: VideoFormat = outputPath.toLowerCase().endsWith('.gif') ? 'gif' : 'mp4';
    const durationMs = frames[frames.length - 1].atMs - frames[0].atMs;

    await encodeFrames(frames, outputPath, format, fps);

    return { outputPath, format, frameCount: frames.length, durationMs };
  }

  /** Discard state without encoding (used on session close). */
  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.writeListener?.dispose();
    this.writeListener = null;
    this.started = false;
    this.frames.length = 0;
  }

  private captureFrame(atMs: number): void {
    const keyLabel = this.pendingKey;
    this.pendingKey = '';
    const { png } = renderTerminalToPng(this.terminal, {
      ...this.options,
      embedFont: false,
      keyLabel,
    });
    this.frames.push({ png, atMs });
  }

  private snapshot(): string {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + this.terminal.rows; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }
}

/**
 * Encode captured frames to a video via ffmpeg's concat demuxer, giving each
 * frame a real display duration derived from when it appeared on screen.
 */
async function encodeFrames(
  frames: Frame[],
  outputPath: string,
  format: VideoFormat,
  fps: number
): Promise<void> {
  // ffmpeg-static's default export is the binary path (typed via esModuleInterop
  // as the module namespace, so coerce through unknown).
  const ffmpegPath = ffmpegStatic as unknown as string | null;
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide a binary for this platform.');
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'tui-video-'));
  try {
    const concatLines: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const filePath = join(tempDir, `frame-${String(i).padStart(5, '0')}.png`);
      writeFileSync(filePath, frames[i].png);

      const nextAt = i + 1 < frames.length ? frames[i + 1].atMs : frames[i].atMs + TAIL_FRAME_SEC * 1000;
      const rawSec = (nextAt - frames[i].atMs) / 1000;
      const durSec = Math.min(MAX_FRAME_SEC, Math.max(MIN_FRAME_SEC, rawSec));

      // concat demuxer: each entry is a file + how long it displays.
      concatLines.push(`file '${filePath.replace(/'/g, "'\\''")}'`);
      concatLines.push(`duration ${durSec.toFixed(3)}`);
    }
    // The demuxer ignores the duration after the last file, so repeat it.
    concatLines.push(`file '${join(tempDir, `frame-${String(frames.length - 1).padStart(5, '0')}.png`).replace(/'/g, "'\\''")}'`);

    const listPath = join(tempDir, 'frames.txt');
    writeFileSync(listPath, concatLines.join('\n'), 'utf-8');

    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];
    if (format === 'gif') {
      // Single-pass palettegen/paletteuse — terminal output has many colors,
      // so a generated palette avoids the ugly default 256-color dither.
      args.push(
        '-vf',
        `fps=${fps},split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=bayer`
      );
    } else {
      // yuv420p for broad player compat; pad to even dimensions (H.264 requires it).
      args.push('-vf', `fps=${fps},pad=ceil(iw/2)*2:ceil(ih/2)*2`, '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    }
    args.push(outputPath);

    await execFileAsync(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

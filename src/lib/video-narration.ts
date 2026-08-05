import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffprobeStatic = require('ffprobe-static') as { path?: string };

export const DEFAULT_POLLY_VOICE_ID = 'Joanna';
export const DEFAULT_POLLY_ENGINE = 'neural';
export const DEFAULT_NARRATION_TARGET_LUFS = -16;
export const DEFAULT_NARRATION_TAIL_PADDING_MS = 500;
export const MAX_NARRATION_CHARACTERS = 3000;

export type PollyEngine = 'standard' | 'neural' | 'long-form' | 'generative';
export type PollyTextType = 'text' | 'ssml';

export interface VideoNarrationOptions {
  videoPath: string;
  outputPath: string;
  narration: string;
  voiceId?: string;
  engine?: PollyEngine;
  textType?: PollyTextType;
  languageCode?: string;
  profile?: string;
  region?: string;
  audioOutputPath?: string;
  targetLufs?: number;
  tailPaddingMs?: number;
  awsPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface VideoNarrationResult {
  outputPath: string;
  audioOutputPath?: string;
  voiceId: string;
  engine: PollyEngine;
  videoDurationMs: number;
  narrationDurationMs: number;
  outputDurationMs: number;
  outputBytes: number;
}

export interface NarratedVideoTiming {
  videoDurationMs: number;
  narrationDurationMs: number;
  tailPaddingMs?: number;
  targetLufs?: number;
}

export function buildPollyArgs(
  narration: string,
  outputPath: string,
  options: Pick<
    VideoNarrationOptions,
    'voiceId' | 'engine' | 'textType' | 'languageCode' | 'profile' | 'region'
  > = {}
): string[] {
  const args = [
    'polly',
    'synthesize-speech',
    '--output-format',
    'mp3',
    '--voice-id',
    options.voiceId ?? DEFAULT_POLLY_VOICE_ID,
    '--engine',
    options.engine ?? DEFAULT_POLLY_ENGINE,
    '--text-type',
    options.textType ?? 'text',
    '--text',
    narration,
  ];

  if (options.languageCode) {
    args.push('--language-code', options.languageCode);
  }
  if (options.profile) {
    args.push('--profile', options.profile);
  }
  if (options.region) {
    args.push('--region', options.region);
  }
  args.push(outputPath);
  return args;
}

export function buildNarratedVideoArgs(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  timing: NarratedVideoTiming
): { args: string[]; outputDurationMs: number } {
  const tailPaddingMs = timing.tailPaddingMs ?? DEFAULT_NARRATION_TAIL_PADDING_MS;
  const targetLufs = timing.targetLufs ?? DEFAULT_NARRATION_TARGET_LUFS;
  validateDuration(timing.videoDurationMs, 'Video duration');
  validateDuration(timing.narrationDurationMs, 'Narration duration');
  validateTailPadding(tailPaddingMs);
  validateTargetLufs(targetLufs);

  const outputDurationMs = Math.max(
    timing.videoDurationMs,
    timing.narrationDurationMs + tailPaddingMs
  );
  const videoPaddingSec = Math.max(0, outputDurationMs - timing.videoDurationMs) / 1000;
  const audioPaddingSec = Math.max(0, outputDurationMs - timing.narrationDurationMs) / 1000;
  const filters: string[] = [];
  let videoMap = '0:v:0';

  if (videoPaddingSec > 0) {
    filters.push(
      `[0:v:0]tpad=stop_mode=clone:stop_duration=${formatSeconds(videoPaddingSec)}[video]`
    );
    videoMap = '[video]';
  }

  const audioFilters = [`loudnorm=I=${targetLufs}:LRA=11:TP=-1.5`];
  if (audioPaddingSec > 0) {
    audioFilters.push(`apad=pad_dur=${formatSeconds(audioPaddingSec)}`);
  }
  filters.push(`[1:a:0]${audioFilters.join(',')}[audio]`);

  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-filter_complex',
    filters.join(';'),
    '-map',
    videoMap,
    '-map',
    '[audio]',
  ];

  if (videoPaddingSec > 0) {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }

  args.push(
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-b:a',
    '192k',
    '-t',
    formatSeconds(outputDurationMs / 1000),
    '-movflags',
    '+faststart',
    outputPath
  );

  return { args, outputDurationMs };
}

export async function narrateVideo(options: VideoNarrationOptions): Promise<VideoNarrationResult> {
  validateNarrationOptions(options);

  const voiceId = options.voiceId ?? DEFAULT_POLLY_VOICE_ID;
  const engine = options.engine ?? DEFAULT_POLLY_ENGINE;
  const ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
  const ffprobePath = resolveFfprobePath(options.ffprobePath);
  const tempDir = await mkdtemp(join(tmpdir(), 'tui-video-narration-'));
  const narrationPath = join(tempDir, 'narration.mp3');
  const narratedVideoPath = join(tempDir, 'narrated.mp4');

  try {
    await access(options.videoPath);
    await synthesizeNarration(options.narration, narrationPath, {
      ...options,
      voiceId,
      engine,
    });

    const [videoDurationMs, narrationDurationMs] = await Promise.all([
      probeMediaDuration(options.videoPath, ffprobePath),
      probeMediaDuration(narrationPath, ffprobePath),
    ]);
    const { args, outputDurationMs } = buildNarratedVideoArgs(
      options.videoPath,
      narrationPath,
      narratedVideoPath,
      {
        videoDurationMs,
        narrationDurationMs,
        tailPaddingMs: options.tailPaddingMs,
        targetLufs: options.targetLufs,
      }
    );

    await runExternalCommand(ffmpegPath, args, 'ffmpeg');
    await mkdir(dirname(options.outputPath), { recursive: true });
    await copyFile(narratedVideoPath, options.outputPath);

    if (options.audioOutputPath) {
      await mkdir(dirname(options.audioOutputPath), { recursive: true });
      await copyFile(narrationPath, options.audioOutputPath);
    }

    return {
      outputPath: options.outputPath,
      ...(options.audioOutputPath ? { audioOutputPath: options.audioOutputPath } : {}),
      voiceId,
      engine,
      videoDurationMs,
      narrationDurationMs,
      outputDurationMs,
      outputBytes: (await stat(options.outputPath)).size,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeNarration(
  narration: string,
  outputPath: string,
  options: VideoNarrationOptions
): Promise<void> {
  await runExternalCommand(
    options.awsPath ?? 'aws',
    buildPollyArgs(narration, outputPath, options),
    'Amazon Polly'
  );
  const output = await stat(outputPath);
  if (output.size === 0) {
    throw new Error('Amazon Polly produced an empty narration file.');
  }
}

async function probeMediaDuration(mediaPath: string, ffprobePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mediaPath],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`Unable to determine media duration for ${mediaPath}.`);
  }
  return Math.round(durationSec * 1000);
}

async function runExternalCommand(
  executable: string,
  args: string[],
  description: string
): Promise<void> {
  try {
    await execFileAsync(executable, args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const failure = error as Error & { stderr?: string | Buffer };
    const stderr = failure.stderr?.toString().trim();
    throw new Error(`${description} failed: ${stderr || failure.message}`);
  }
}

function resolveFfmpegPath(override?: string): string {
  if (override) return override;
  const bundledPath = ffmpegStatic as unknown as string | null;
  if (!bundledPath) {
    throw new Error('ffmpeg-static did not provide a binary for this platform.');
  }
  return bundledPath;
}

function resolveFfprobePath(override?: string): string {
  const path = override ?? ffprobeStatic.path;
  if (!path) {
    throw new Error('ffprobe-static did not provide a binary for this platform.');
  }
  return path;
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

function validateNarrationOptions(options: VideoNarrationOptions): void {
  if (!options.videoPath.trim()) {
    throw new Error('Video path must not be empty.');
  }
  if (!options.outputPath.trim()) {
    throw new Error('Output path must not be empty.');
  }
  if (!options.narration.trim()) {
    throw new Error('Narration must not be empty.');
  }
  if (options.narration.length > MAX_NARRATION_CHARACTERS) {
    throw new Error(`Narration must not exceed ${MAX_NARRATION_CHARACTERS} characters.`);
  }
  if (options.audioOutputPath) {
    const audioOutputPath = resolve(options.audioOutputPath);
    if (resolve(options.outputPath) === audioOutputPath) {
      throw new Error('Video and audio output paths must be different.');
    }
    if (resolve(options.videoPath) === audioOutputPath) {
      throw new Error('Source video and audio output paths must be different.');
    }
  }
  if (options.tailPaddingMs !== undefined) {
    validateTailPadding(options.tailPaddingMs);
  }
  if (options.targetLufs !== undefined) {
    validateTargetLufs(options.targetLufs);
  }
}

function validateDuration(durationMs: number, label: string): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
}

function validateTailPadding(tailPaddingMs: number): void {
  if (!Number.isInteger(tailPaddingMs) || tailPaddingMs < 0 || tailPaddingMs > 10_000) {
    throw new Error('Narration tail padding must be an integer between 0 and 10000 milliseconds.');
  }
}

function validateTargetLufs(targetLufs: number): void {
  if (!Number.isFinite(targetLufs) || targetLufs < -24 || targetLufs > -10) {
    throw new Error('Narration target loudness must be between -24 and -10 LUFS.');
  }
}

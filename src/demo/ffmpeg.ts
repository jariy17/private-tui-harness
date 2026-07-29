import { mkdir, stat } from 'fs/promises';
import { dirname, extname } from 'path';
import { spawn, type SpawnOptions } from 'child_process';

const MAX_ERROR_OUTPUT = 32_000;

export interface TimedAudioClip {
  path: string;
  startMs: number;
}

export interface EncodeVideoOptions {
  framesPattern: string;
  fps: number;
  outputPath: string;
  format: 'mp4' | 'webm';
  durationMs: number;
  audioClips: TimedAudioClip[];
  ffmpegPath?: string;
}

export interface EncodeVisualVideoOptions extends Omit<EncodeVideoOptions, 'framesPattern'> {
  visualPath: string;
}

export interface EncodeNarrationOptions {
  outputPath: string;
  durationMs: number;
  audioClips: TimedAudioClip[];
  ffmpegPath?: string;
}

export async function probeMediaDuration(path: string, ffprobePath = 'ffprobe'): Promise<number> {
  const result = await runExternalCommand(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    'ffprobe'
  );
  const seconds = Number(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`ffprobe returned an invalid duration for ${path}: ${result.stdout.trim()}`);
  }
  return Math.ceil(seconds * 1000);
}

export async function encodeDemoVideo(options: EncodeVideoOptions): Promise<void> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(options.fps),
    '-start_number',
    '1',
    '-i',
    options.framesPattern,
  ];

  for (const clip of options.audioClips) {
    args.push('-i', clip.path);
  }

  if (options.audioClips.length > 0) {
    args.push(
      '-filter_complex',
      buildTimedAudioFilter(options.audioClips, 1, options.durationMs),
      '-map',
      '0:v:0',
      '-map',
      '[audio]'
    );
  } else {
    args.push('-map', '0:v:0');
  }

  args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-t', formatSeconds(options.durationMs));

  if (options.format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
    if (options.audioClips.length > 0) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    }
    args.push('-movflags', '+faststart');
  } else {
    args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p');
    if (options.audioClips.length > 0) {
      args.push('-c:a', 'libopus', '-b:a', '160k', '-ar', '48000');
    }
  }

  args.push(options.outputPath);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await runExternalCommand(ffmpegPath, args, 'FFmpeg');

  const output = await stat(options.outputPath).catch(() => undefined);
  if (!output?.isFile() || output.size === 0) {
    throw new Error(`FFmpeg completed without creating a video at ${options.outputPath}.`);
  }
}

export async function encodeVisualDemoVideo(options: EncodeVisualVideoOptions): Promise<void> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const args = ['-y', '-loglevel', 'error'];
  if (extname(options.visualPath).toLowerCase() === '.gif') {
    args.push('-ignore_loop', '1');
  }
  args.push('-i', options.visualPath);

  for (const clip of options.audioClips) {
    args.push('-i', clip.path);
  }

  if (options.audioClips.length > 0) {
    args.push(
      '-filter_complex',
      buildTimedAudioFilter(options.audioClips, 1, options.durationMs),
      '-map',
      '0:v:0',
      '-map',
      '[audio]'
    );
  } else {
    args.push('-map', '0:v:0');
  }

  args.push(
    '-vf',
    `fps=${options.fps},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    '-t',
    formatSeconds(options.durationMs)
  );
  appendCodecArgs(args, options.format, options.audioClips.length > 0);
  args.push(options.outputPath);

  await mkdir(dirname(options.outputPath), { recursive: true });
  await runExternalCommand(ffmpegPath, args, 'FFmpeg');
  await assertNonEmptyOutput(options.outputPath, 'video');
}

export async function encodeNarrationTrack(options: EncodeNarrationOptions): Promise<void> {
  if (options.audioClips.length === 0) {
    throw new Error('Cannot encode a narration track without audio clips.');
  }

  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const args = ['-y', '-loglevel', 'error'];
  for (const clip of options.audioClips) {
    args.push('-i', clip.path);
  }
  args.push(
    '-filter_complex',
    buildTimedAudioFilter(options.audioClips, 0, options.durationMs),
    '-map',
    '[audio]'
  );

  const extension = extname(options.outputPath).toLowerCase();
  if (extension === '.wav') {
    args.push('-c:a', 'pcm_s16le', '-ar', '48000');
  } else if (extension === '.mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', '192k');
  } else if (extension === '.m4a') {
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    throw new Error('Narration output must use a .wav, .mp3, or .m4a extension.');
  }
  args.push(options.outputPath);

  await mkdir(dirname(options.outputPath), { recursive: true });
  await runExternalCommand(ffmpegPath, args, 'FFmpeg');
  await assertNonEmptyOutput(options.outputPath, 'narration track');
}

export async function runExternalCommand(
  executable: string,
  args: string[],
  label: string,
  options: Pick<SpawnOptions, 'cwd' | 'env'> = {}
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(executable, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => {
      stdout = appendBounded(stdout, String(chunk));
    });
    child.stderr.on('data', chunk => {
      stderr = appendBounded(stderr, String(chunk));
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      const suffix =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? ` Install ${label} or pass its executable path explicitly.`
          : '';
      reject(new Error(`Unable to run ${label} (${executable}): ${error.message}.${suffix}`));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim() || stdout.trim() || 'no diagnostic output';
        reject(new Error(`${label} exited with code ${String(code)}: ${detail}`));
      }
    });
  });
}

function buildTimedAudioFilter(
  audioClips: TimedAudioClip[],
  inputOffset: number,
  durationMs: number
): string {
  const filters: string[] = [];
  const delayedInputs: string[] = [];
  for (let index = 0; index < audioClips.length; index++) {
    const delayMs = Math.max(0, Math.round(audioClips[index]!.startMs));
    const outputLabel = `audio${index}`;
    filters.push(`[${index + inputOffset}:a]adelay=${delayMs}:all=1[${outputLabel}]`);
    delayedInputs.push(`[${outputLabel}]`);
  }
  filters.push(
    `${delayedInputs.join('')}amix=inputs=${audioClips.length}:duration=longest:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=duration=${formatSeconds(durationMs)}[audio]`
  );
  return filters.join(';');
}

function appendCodecArgs(args: string[], format: 'mp4' | 'webm', hasAudio: boolean): void {
  if (format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
    if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    }
    args.push('-movflags', '+faststart');
  } else {
    args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p');
    if (hasAudio) {
      args.push('-c:a', 'libopus', '-b:a', '160k', '-ar', '48000');
    }
  }
}

async function assertNonEmptyOutput(path: string, label: string): Promise<void> {
  const output = await stat(path).catch(() => undefined);
  if (!output?.isFile() || output.size === 0) {
    throw new Error(`FFmpeg completed without creating a ${label} at ${path}.`);
  }
}

function appendBounded(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= MAX_ERROR_OUTPUT ? combined : combined.slice(combined.length - MAX_ERROR_OUTPUT);
}

function formatSeconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

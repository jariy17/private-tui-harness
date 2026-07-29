import { probeMediaDuration, runExternalCommand } from './ffmpeg.js';
import type {
  DemoPollyOptions,
  DemoRecording,
  PreparedNarrationClip,
} from './types.js';
import { access, mkdir } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';

export interface PrepareNarrationOptions {
  workDir: string;
  recordingBaseDir: string;
  polly?: DemoPollyOptions;
  ffprobePath?: string;
}

export async function prepareNarration(
  recording: DemoRecording,
  options: PrepareNarrationOptions
): Promise<PreparedNarrationClip[]> {
  const clips: PreparedNarrationClip[] = [];
  const narrationDir = join(options.workDir, 'narration');
  await mkdir(narrationDir, { recursive: true });

  for (let eventIndex = 0; eventIndex < recording.events.length; eventIndex++) {
    const event = recording.events[eventIndex]!;
    if (event.type !== 'marker') {
      continue;
    }

    let audioPath: string | undefined;
    if (event.audioPath) {
      audioPath = isAbsolute(event.audioPath)
        ? event.audioPath
        : resolve(options.recordingBaseDir, event.audioPath);
      await assertReadable(audioPath);
    } else if (event.narration && options.polly) {
      audioPath = join(narrationDir, `marker-${String(eventIndex).padStart(5, '0')}.mp3`);
      await synthesizeWithPolly(event.narration, audioPath, options.polly);
    }

    if (!audioPath) {
      continue;
    }

    clips.push({
      markerIndex: eventIndex,
      path: audioPath,
      durationMs: await probeMediaDuration(audioPath, options.ffprobePath),
    });
  }

  return clips;
}

export function buildPollyArgs(text: string, outputPath: string, options: DemoPollyOptions): string[] {
  const args = [
    'polly',
    'synthesize-speech',
    '--output-format',
    'mp3',
    '--voice-id',
    options.voiceId,
    '--text-type',
    'text',
    '--text',
    text,
  ];

  if (options.engine) {
    args.push('--engine', options.engine);
  }
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

async function synthesizeWithPolly(text: string, outputPath: string, options: DemoPollyOptions): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await runExternalCommand(
    options.awsPath ?? 'aws',
    buildPollyArgs(text, outputPath, options),
    'AWS CLI for Amazon Polly'
  );
  await assertReadable(outputPath);
}

async function assertReadable(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Narration audio file is not readable: ${path}`);
  }
}

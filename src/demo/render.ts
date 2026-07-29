import { encodeDemoVideo, encodeNarrationTrack, encodeVisualDemoVideo } from './ffmpeg.js';
import { renderMacVisual } from './mac.js';
import { prepareNarration } from './narration.js';
import { buildDemoTimeline, replayDemoFrames } from './replay.js';
import { assertDemoRecording, readDemoRecording } from './recorder.js';
import type {
  DemoRecording,
  DemoRenderOptions,
  DemoRenderResult,
  DemoTimeline,
  PreparedNarrationClip,
} from './types.js';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { dirname, extname, join, parse, resolve } from 'path';
import { tmpdir } from 'os';

const DEFAULT_FPS = 30;
const DEFAULT_TAIL_HOLD_MS = 1000;
const DEFAULT_CAPTION_DURATION_MS = 2000;

export async function renderDemo(options: DemoRenderOptions): Promise<DemoRenderResult> {
  const recordingSource = options.recording;
  const recording =
    typeof recordingSource === 'string' ? await readDemoRecording(recordingSource) : recordingSource;
  if (typeof recordingSource !== 'string') {
    assertDemoRecording(recording);
  }

  const outputPath = resolve(options.outputPath);
  const format = resolveFormat(outputPath, options.format);
  const renderer = options.renderer ?? 'native';
  const fps = options.fps ?? DEFAULT_FPS;
  const tailHoldMs = options.tailHoldMs ?? DEFAULT_TAIL_HOLD_MS;
  validateRenderNumbers(fps, tailHoldMs, options.fontSize);

  const suppliedWorkDir = options.workDir ? resolve(options.workDir) : undefined;
  const workDir = suppliedWorkDir ?? (await mkdtemp(join(tmpdir(), 'tui-harness-demo-')));
  const shouldClean = !suppliedWorkDir && !options.keepWorkDir;
  const recordingBaseDir =
    typeof recordingSource === 'string' ? dirname(resolve(recordingSource)) : process.cwd();

  await mkdir(workDir, { recursive: true });

  try {
    const narrationClips = await prepareNarration(recording, {
      workDir,
      recordingBaseDir,
      polly: options.polly,
      ffprobePath: options.ffprobePath,
    });

    if (renderer === 'mac') {
      const visual = await renderMacVisual(recording, {
        workDir,
        theme: options.theme ?? 'dark',
        title: options.title,
        fontSize: options.fontSize,
        captions: options.captions ?? true,
        tailHoldMs,
        narrationClips,
        mac: options.mac,
      });
      const timedAudio = buildMacTimedAudio(narrationClips, visual.scenes);
      await encodeVisualDemoVideo({
        visualPath: visual.visualMasterPath,
        fps,
        outputPath,
        format,
        durationMs: visual.durationMs,
        audioClips: timedAudio,
        ffmpegPath: options.ffmpegPath,
      });
      const narrationPath = await writeNarrationOutput(options, timedAudio, visual.durationMs);
      const timeline: DemoTimeline = {
        outputEvents: [],
        markers: visual.scenes.map(scene => ({
          eventIndex: scene.eventIndex,
          sourceAtMs: scene.sourceAtMs,
          outputAtMs: scene.startMs,
          holdMs: scene.holdMs,
          ...(scene.caption ? { caption: scene.caption } : {}),
        })),
        durationMs: visual.durationMs,
      };
      const captionsPath =
        options.captions === false ? undefined : await writeCaptions(outputPath, timeline);

      return {
        outputPath,
        ...(captionsPath ? { captionsPath } : {}),
        ...(narrationPath ? { narrationPath } : {}),
        ...(!shouldClean
          ? {
              visualMasterPath: visual.visualMasterPath,
              macProgramPath: visual.macProgramPath,
              macManifestPath: visual.macManifestPath,
            }
          : {}),
        format,
        renderer,
        durationMs: visual.durationMs,
        frameCount: visual.frameCount,
        width: visual.width + (visual.width % 2),
        height: visual.height + (visual.height % 2),
        narrationClips: narrationClips.length,
        ...(!shouldClean ? { workDir } : {}),
      };
    }

    const timeline = buildDemoTimeline(recording, narrationClips, tailHoldMs);
    const framesDir = join(workDir, 'frames');
    const frames = await replayDemoFrames(recording, timeline, {
      framesDir,
      fps,
      theme: options.theme ?? 'dark',
      title: options.title,
      fontSize: options.fontSize,
      captions: options.captions ?? true,
    });

    const timedAudio = narrationClips.map(clip => {
      const marker = timeline.markers.find(candidate => candidate.eventIndex === clip.markerIndex);
      if (!marker) {
        throw new Error(`Narration marker ${clip.markerIndex} is missing from the rendered timeline.`);
      }
      return { path: clip.path, startMs: marker.outputAtMs };
    });

    await encodeDemoVideo({
      framesPattern: join(framesDir, 'frame-%08d.png'),
      fps,
      outputPath,
      format,
      durationMs: timeline.durationMs,
      audioClips: timedAudio,
      ffmpegPath: options.ffmpegPath,
    });
    const narrationPath = await writeNarrationOutput(options, timedAudio, timeline.durationMs);

    const captionsPath =
      options.captions === false ? undefined : await writeCaptions(outputPath, timeline);

    return {
      outputPath,
      ...(captionsPath ? { captionsPath } : {}),
      ...(narrationPath ? { narrationPath } : {}),
      format,
      renderer,
      durationMs: timeline.durationMs,
      frameCount: frames.frameCount,
      width: frames.width + (frames.width % 2),
      height: frames.height + (frames.height % 2),
      narrationClips: narrationClips.length,
      ...(!shouldClean ? { workDir } : {}),
    };
  } finally {
    if (shouldClean) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function buildMacTimedAudio(
  narrationClips: PreparedNarrationClip[],
  scenes: Awaited<ReturnType<typeof renderMacVisual>>['scenes']
) {
  return narrationClips.map(clip => {
    const scene = scenes.find(candidate => candidate.eventIndex === clip.markerIndex);
    if (!scene) {
      throw new Error(`Narration marker ${clip.markerIndex} is missing from the Mac visual timeline.`);
    }
    return { path: clip.path, startMs: scene.startMs };
  });
}

async function writeNarrationOutput(
  options: DemoRenderOptions,
  audioClips: Array<{ path: string; startMs: number }>,
  durationMs: number
): Promise<string | undefined> {
  if (!options.narrationOutputPath) {
    return undefined;
  }
  if (audioClips.length === 0) {
    throw new Error('narrationOutputPath was provided, but the recording has no narration audio.');
  }
  const narrationPath = resolve(options.narrationOutputPath);
  await encodeNarrationTrack({
    outputPath: narrationPath,
    durationMs,
    audioClips,
    ffmpegPath: options.ffmpegPath,
  });
  return narrationPath;
}

function resolveFormat(outputPath: string, requested?: 'mp4' | 'webm'): 'mp4' | 'webm' {
  if (requested) {
    return requested;
  }
  const extension = extname(outputPath).toLowerCase();
  if (extension === '.mp4') return 'mp4';
  if (extension === '.webm') return 'webm';
  throw new Error('Unable to infer video format. Use an .mp4 or .webm output path, or provide format.');
}

function validateRenderNumbers(fps: number, tailHoldMs: number, fontSize?: number): void {
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error(`fps must be an integer between 1 and 60; received ${fps}.`);
  }
  if (!Number.isFinite(tailHoldMs) || tailHoldMs < 0 || tailHoldMs > 60_000) {
    throw new Error(`tailHoldMs must be between 0 and 60000; received ${tailHoldMs}.`);
  }
  if (fontSize !== undefined && (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48)) {
    throw new Error(`fontSize must be between 8 and 48; received ${fontSize}.`);
  }
}

async function writeCaptions(outputPath: string, timeline: ReturnType<typeof buildDemoTimeline>): Promise<string | undefined> {
  const captions = timeline.markers.filter(marker => marker.caption);
  if (captions.length === 0) {
    return undefined;
  }

  const entries = captions.map((marker, index) => {
    const next = captions[index + 1];
    const candidateEndMs = Math.min(
      marker.outputAtMs + Math.max(marker.holdMs, DEFAULT_CAPTION_DURATION_MS),
      next?.outputAtMs ?? timeline.durationMs
    );
    const endMs = Math.max(marker.outputAtMs + 1, candidateEndMs);
    return `${index + 1}\n${formatSrtTimestamp(marker.outputAtMs)} --> ${formatSrtTimestamp(endMs)}\n${marker.caption}\n`;
  });

  const parsed = parse(outputPath);
  const captionsPath = join(parsed.dir, `${parsed.name}.srt`);
  await mkdir(parsed.dir, { recursive: true });
  await writeFile(captionsPath, `${entries.join('\n')}\n`, 'utf-8');
  return captionsPath;
}

function formatSrtTimestamp(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

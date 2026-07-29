import { rasterizeSvg } from './rasterizer.js';
import type {
  DemoRecording,
  DemoTimeline,
  DemoTimelineMarker,
  PreparedNarrationClip,
} from './types.js';
import { DARK_THEME, LIGHT_THEME, renderTerminalToSvg } from '../lib/svg-renderer.js';
import xtermHeadless from '@xterm/headless';
import { copyFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const { Terminal } = xtermHeadless;
const DEFAULT_CAPTION_DURATION_MS = 2000;

export interface ReplayFramesOptions {
  framesDir: string;
  fps: number;
  theme: 'dark' | 'light';
  title?: string;
  fontSize?: number;
  captions: boolean;
}

export interface ReplayFramesResult {
  frameCount: number;
  width: number;
  height: number;
}

export function buildDemoTimeline(
  recording: DemoRecording,
  narrationClips: PreparedNarrationClip[] = [],
  tailHoldMs = 1000
): DemoTimeline {
  const narrationDurations = new Map(narrationClips.map(clip => [clip.markerIndex, clip.durationMs]));
  const outputEvents: DemoTimeline['outputEvents'] = [];
  const markers: DemoTimelineMarker[] = [];
  let insertedHoldMs = 0;
  let latestOutputAtMs = 0;

  for (let eventIndex = 0; eventIndex < recording.events.length; eventIndex++) {
    const event = recording.events[eventIndex]!;
    const outputAtMs = event.atMs + insertedHoldMs;

    if (event.type === 'output') {
      outputEvents.push({ ...event, outputAtMs });
      latestOutputAtMs = Math.max(latestOutputAtMs, outputAtMs);
      continue;
    }

    if (event.type === 'marker') {
      const holdMs = Math.max(event.holdMs, narrationDurations.get(eventIndex) ?? 0);
      markers.push({
        eventIndex,
        sourceAtMs: event.atMs,
        outputAtMs,
        holdMs,
        ...(event.caption || event.narration ? { caption: event.caption ?? event.narration } : {}),
      });
      insertedHoldMs += holdMs;
      latestOutputAtMs = Math.max(latestOutputAtMs, outputAtMs + holdMs);
      continue;
    }

    latestOutputAtMs = Math.max(latestOutputAtMs, outputAtMs);
  }

  return {
    outputEvents,
    markers,
    durationMs: Math.max(1, Math.ceil(latestOutputAtMs + Math.max(0, tailHoldMs))),
  };
}

export function captionAt(timeline: DemoTimeline, atMs: number): string | undefined {
  for (let index = timeline.markers.length - 1; index >= 0; index--) {
    const marker = timeline.markers[index]!;
    if (!marker.caption || marker.outputAtMs > atMs) {
      continue;
    }
    const nextCaption = timeline.markers.slice(index + 1).find(candidate => candidate.caption);
    const naturalEnd = marker.outputAtMs + Math.max(marker.holdMs, DEFAULT_CAPTION_DURATION_MS);
    const end = Math.min(naturalEnd, nextCaption?.outputAtMs ?? timeline.durationMs);
    return atMs < end ? marker.caption : undefined;
  }
  return undefined;
}

export async function replayDemoFrames(
  recording: DemoRecording,
  timeline: DemoTimeline,
  options: ReplayFramesOptions
): Promise<ReplayFramesResult> {
  const terminal = new Terminal({
    cols: recording.metadata.cols,
    rows: recording.metadata.rows,
    allowProposedApi: true,
  });
  const frameCount = Math.max(1, Math.ceil((timeline.durationMs * options.fps) / 1000));
  const captionHeight = options.captions && timeline.markers.some(marker => marker.caption) ? 56 : 0;
  let outputIndex = 0;
  let previousStateKey: string | undefined;
  let previousFramePath: string | undefined;
  let width = 0;
  let height = 0;

  await mkdir(options.framesDir, { recursive: true });

  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const atMs = (frameIndex * 1000) / options.fps;
      while (
        outputIndex < timeline.outputEvents.length &&
        timeline.outputEvents[outputIndex]!.outputAtMs <= atMs
      ) {
        await writeTerminal(terminal, timeline.outputEvents[outputIndex]!.data);
        outputIndex += 1;
      }

      const caption = options.captions ? captionAt(timeline, atMs) : undefined;
      const stateKey = `${outputIndex}\0${caption ?? ''}`;
      const framePath = join(options.framesDir, `frame-${String(frameIndex + 1).padStart(8, '0')}.png`);

      if (stateKey === previousStateKey && previousFramePath) {
        await copyFile(previousFramePath, framePath);
      } else {
        const svg = renderTerminalToSvg(terminal, {
          theme: options.theme === 'light' ? LIGHT_THEME : DARK_THEME,
          title: options.title,
          fontSize: options.fontSize,
          showCursor: false,
          captionText: caption,
          captionHeight,
        });
        const frame = rasterizeSvg(svg);
        await writeFile(framePath, frame.png);
        width = frame.width;
        height = frame.height;
      }

      previousStateKey = stateKey;
      previousFramePath = framePath;
    }
  } finally {
    terminal.dispose();
  }

  return { frameCount, width, height };
}

function writeTerminal(terminal: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise<void>(resolve => terminal.write(data, resolve));
}

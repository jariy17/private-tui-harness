import { readMacFrameSequenceManifest, runExternalCommand } from './ffmpeg.js';
import { rasterizeSvg } from './rasterizer.js';
import type {
  DemoKeyframe,
  DemoKeyframeExportResult,
  DemoMacEasing,
  DemoMacManifest,
  DemoMacOptions,
  DemoMacScene,
  DemoMacTransition,
  DemoRecording,
  PreparedNarrationClip,
} from './types.js';
import { DARK_THEME, LIGHT_THEME, renderTerminalToSvg } from '../lib/svg-renderer.js';
import xtermHeadless from '@xterm/headless';
import { mkdir, rm, writeFile } from 'fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'path';

const { Terminal } = xtermHeadless;

const DEFAULT_CAPTION_HEIGHT = 72;
const DEFAULT_CAPTION_FONT_SIZE = 24;
const DEFAULT_NARRATION_PADDING_MS = 300;
const DEFAULT_TRANSITION: DemoMacTransition = 'crossfade';
const DEFAULT_TRANSITION_MS = 500;
const DEFAULT_EASING: DemoMacEasing = 'easeInOut';
const MAC_TRANSITION_FPS = 15;
const MAX_MAC_FRAMES = 500;
const VISUAL_FRAMES_DIR_NAME = 'visual-frames';
const VISUAL_FRAMES_MANIFEST_FILE_NAME = 'manifest.json';
const MANIFEST_FILE_NAME = 'manifest.json';

export interface ExportDemoKeyframesOptions {
  outputDir: string;
  theme: 'dark' | 'light';
  title?: string;
  fontSize?: number;
  reserveCaptionArea?: boolean;
}

export interface RenderMacVisualOptions {
  workDir: string;
  theme: 'dark' | 'light';
  title?: string;
  fontSize?: number;
  captions: boolean;
  tailHoldMs: number;
  narrationClips: PreparedNarrationClip[];
  mac?: DemoMacOptions;
}

export interface RenderMacVisualResult {
  visualMasterPath: string;
  macProgramPath: string;
  macManifestPath: string;
  scenes: DemoMacScene[];
  durationMs: number;
  frameCount: number;
  width: number;
  height: number;
}

export async function exportDemoKeyframes(
  recording: DemoRecording,
  options: ExportDemoKeyframesOptions
): Promise<DemoKeyframeExportResult> {
  const outputDir = resolve(options.outputDir);
  const terminal = new Terminal({
    cols: recording.metadata.cols,
    rows: recording.metadata.rows,
    allowProposedApi: true,
  });
  const keyframes: DemoKeyframe[] = [];
  let width = 0;
  let height = 0;

  await mkdir(outputDir, { recursive: true });

  try {
    for (let eventIndex = 0; eventIndex < recording.events.length; eventIndex++) {
      const event = recording.events[eventIndex]!;
      if (event.type === 'output') {
        await writeTerminal(terminal, event.data);
        continue;
      }
      if (event.type !== 'marker') {
        continue;
      }

      const keyframeIndex = keyframes.length;
      const fileName = `${String(keyframeIndex + 1).padStart(3, '0')}-${frameSlug(event.label, eventIndex)}.png`;
      const path = join(outputDir, fileName);
      const svg = renderTerminalToSvg(terminal, {
        theme: options.theme === 'light' ? LIGHT_THEME : DARK_THEME,
        title: options.title,
        fontSize: options.fontSize,
        showCursor: false,
        captionHeight: options.reserveCaptionArea ? DEFAULT_CAPTION_HEIGHT : 0,
      });
      const frame = rasterizeSvg(svg);
      await writeFile(path, frame.png);
      width = frame.width;
      height = frame.height;

      keyframes.push({
        index: keyframeIndex,
        eventIndex,
        sourceAtMs: event.atMs,
        path,
        holdMs: event.holdMs,
        ...(event.label ? { label: event.label } : {}),
        ...(event.caption || event.narration ? { caption: event.caption ?? event.narration } : {}),
        ...(event.narration ? { narration: event.narration } : {}),
        ...(event.audioPath ? { audioPath: event.audioPath } : {}),
      });
    }
  } finally {
    terminal.dispose();
  }

  if (keyframes.length === 0) {
    throw new Error('Mac rendering requires at least one demo marker.');
  }

  return { keyframes, width, height };
}

export async function renderMacVisual(
  recording: DemoRecording,
  options: RenderMacVisualOptions
): Promise<RenderMacVisualResult> {
  const workDir = resolve(options.workDir);
  const sourceFramesDir = join(workDir, 'source-frames');
  const programFileName = validateProgramFileName(options.mac?.programFileName ?? 'demo.mac');
  const macProgramPath = join(workDir, programFileName);
  const macManifestPath = join(workDir, MANIFEST_FILE_NAME);
  const visualMasterPath = join(workDir, VISUAL_FRAMES_DIR_NAME, VISUAL_FRAMES_MANIFEST_FILE_NAME);
  const transition = options.mac?.transition ?? DEFAULT_TRANSITION;
  const transitionMs = options.mac?.transitionMs ?? DEFAULT_TRANSITION_MS;
  const easing = options.mac?.easing ?? DEFAULT_EASING;
  const captionFontSize = options.mac?.captionFontSize ?? DEFAULT_CAPTION_FONT_SIZE;
  const narrationPaddingMs = options.mac?.narrationPaddingMs ?? DEFAULT_NARRATION_PADDING_MS;

  validateMacOptions(transitionMs, captionFontSize, narrationPaddingMs);
  await mkdir(workDir, { recursive: true });

  const exported = await exportDemoKeyframes(recording, {
    outputDir: sourceFramesDir,
    theme: options.theme,
    title: options.title,
    fontSize: options.fontSize,
    reserveCaptionArea: options.captions,
  });
  const clipsByMarker = new Map(options.narrationClips.map(clip => [clip.markerIndex, clip]));
  const transitionDurationMs = transitionMs > 0 ? renderedTransitionDuration(transitionMs) : 0;
  let startMs = 0;

  const scenes = exported.keyframes.map((keyframe, index): DemoMacScene => {
    const clip = clipsByMarker.get(keyframe.eventIndex);
    const finalHoldMs = index === exported.keyframes.length - 1 ? options.tailHoldMs : 0;
    const holdMs = quantizeMacFrameDuration(
      Math.max(keyframe.holdMs, clip ? clip.durationMs + narrationPaddingMs : 0) + finalHoldMs
    );
    const hasTransition = transitionMs > 0 && index < exported.keyframes.length - 1;
    const scene: DemoMacScene = {
      index,
      eventIndex: keyframe.eventIndex,
      sourceAtMs: keyframe.sourceAtMs,
      sourceFrame: toPosixPath(relative(workDir, keyframe.path)),
      startMs,
      holdMs,
      ...(keyframe.label ? { label: keyframe.label } : {}),
      ...(options.captions && keyframe.caption ? { caption: keyframe.caption } : {}),
      ...(keyframe.narration ? { narration: keyframe.narration } : {}),
      ...(clip ? { audioPath: clip.path } : keyframe.audioPath ? { audioPath: keyframe.audioPath } : {}),
      ...(hasTransition
        ? {
            transition: {
              type: transition,
              requestedDurationMs: transitionMs,
              renderedDurationMs: transitionDurationMs,
              easing,
            },
          }
        : {}),
    };
    startMs += holdMs + (hasTransition ? transitionDurationMs : 0);
    return scene;
  });

  const frameCount =
    scenes.length +
    scenes.reduce(
      (count, scene) =>
        count + (scene.transition ? renderedTransitionFrameCount(scene.transition.requestedDurationMs) : 0),
      0
    );
  if (frameCount > MAX_MAC_FRAMES) {
    throw new Error(
      `Mac visual timeline requires ${frameCount} frames, exceeding the ${MAX_MAC_FRAMES}-frame limit.`
    );
  }

  const program = buildMacProgram({
    scenes,
    width: exported.width,
    height: exported.height,
    captions: options.captions,
    captionFontSize,
    visualFramesDirName: VISUAL_FRAMES_DIR_NAME,
  });
  const manifest: DemoMacManifest = {
    version: 1,
    renderer: 'mac',
    width: exported.width,
    height: exported.height,
    durationMs: startMs,
    frameCount,
    program: programFileName,
    visualMaster: `${VISUAL_FRAMES_DIR_NAME}/${VISUAL_FRAMES_MANIFEST_FILE_NAME}`,
    scenes,
  };

  await Promise.all([
    writeFile(macProgramPath, program, 'utf-8'),
    writeFile(macManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'),
    rm(visualMasterPath, { force: true }),
  ]);
  await runExternalCommand(
    resolveExecutablePath(options.mac?.executablePath),
    [macProgramPath],
    'Mac (Meme as Code)',
    {
      cwd: workDir,
      env: { ...process.env, MAC_OUTPUT_DIR: workDir },
    }
  );
  const frameSequence = await readMacFrameSequenceManifest(visualMasterPath);
  if (frameSequence.manifest.width !== exported.width || frameSequence.manifest.height !== exported.height) {
    throw new Error(
      `Mac frame sequence dimensions ${frameSequence.manifest.width}x${frameSequence.manifest.height} do not match the source ${exported.width}x${exported.height}.`
    );
  }
  if (frameSequence.manifest.frames.length !== frameCount) {
    throw new Error(
      `Mac frame sequence contains ${frameSequence.manifest.frames.length} frames; expected ${frameCount}.`
    );
  }
  if (frameSequence.durationMs !== startMs) {
    throw new Error(
      `Mac frame sequence duration is ${frameSequence.durationMs}ms; expected ${startMs}ms.`
    );
  }

  return {
    visualMasterPath,
    macProgramPath,
    macManifestPath,
    scenes,
    durationMs: startMs,
    frameCount,
    width: exported.width,
    height: exported.height,
  };
}

export function buildMacProgram(options: {
  scenes: DemoMacScene[];
  width: number;
  height: number;
  captions: boolean;
  captionFontSize: number;
  visualFramesDirName: string;
}): string {
  const lines = [
    '// Generated by tui-harness-mcp. Mac owns scene composition, captions, timing, and transitions.',
  ];

  if (options.captions) {
    lines.push(
      'style walkthroughCaption {',
      '    color: "#F8FAFC"',
      '    outline: 0',
      '    shadow: 2',
      '    shadowColor: "#000000CC"',
      `    fontSize: ${options.captionFontSize}`,
      '    fontWeight: "normal"',
      '    textTransform: "none"',
      '}',
      ''
    );
  }

  lines.push('val walkthrough = gif {');
  for (const scene of options.scenes) {
    const source = escapeMacString(scene.sourceFrame);
    if (options.captions) {
      lines.push(
        `    @"${source}" ${options.width}x${options.height} walkthroughCaption { bottom: "${escapeMacString(scene.caption ?? '')}" } : ${scene.holdMs}ms`
      );
    } else {
      lines.push(`    @"${source}" "" : ${scene.holdMs}ms`);
    }
    if (scene.transition) {
      lines.push(
        `    --- ${scene.transition.type} ${scene.transition.requestedDurationMs}ms ${scene.transition.easing} ---`
      );
    }
  }
  lines.push(
    '};',
    `walkthrough.saveFrames("${escapeMacString(options.visualFramesDirName)}");`,
    `print "Saved ${escapeMacString(options.visualFramesDirName)}";`,
    ''
  );
  return lines.join('\n');
}

function validateMacOptions(transitionMs: number, captionFontSize: number, narrationPaddingMs: number): void {
  if (!Number.isInteger(transitionMs) || transitionMs < 0 || transitionMs > 5000) {
    throw new Error(`mac.transitionMs must be an integer between 0 and 5000; received ${transitionMs}.`);
  }
  if (!Number.isFinite(captionFontSize) || captionFontSize < 10 || captionFontSize > 96) {
    throw new Error(`mac.captionFontSize must be between 10 and 96; received ${captionFontSize}.`);
  }
  if (!Number.isInteger(narrationPaddingMs) || narrationPaddingMs < 0 || narrationPaddingMs > 10_000) {
    throw new Error(
      `mac.narrationPaddingMs must be an integer between 0 and 10000; received ${narrationPaddingMs}.`
    );
  }
}

function validateProgramFileName(value: string): string {
  if (
    !value ||
    value.includes('/') ||
    value.includes('\\') ||
    basename(value) !== value ||
    extname(value).toLowerCase() !== '.mac'
  ) {
    throw new Error(`mac.programFileName must be a plain .mac filename; received "${value}".`);
  }
  return value;
}

function resolveExecutablePath(value: string | undefined): string {
  if (!value) {
    return 'mac';
  }
  return value.includes('/') || value.includes('\\') ? resolve(value) : value;
}

function frameSlug(label: string | undefined, eventIndex: number): string {
  const slug = (label ?? `marker-${eventIndex}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `marker-${eventIndex}`;
}

function quantizeMacFrameDuration(milliseconds: number): number {
  return Math.max(10, Math.ceil(milliseconds / 10) * 10);
}

function renderedTransitionFrameCount(milliseconds: number): number {
  return Math.max(2, Math.floor((milliseconds * MAC_TRANSITION_FPS) / 1000)) - 1;
}

function renderedTransitionDuration(milliseconds: number): number {
  const frameCount = renderedTransitionFrameCount(milliseconds) + 1;
  const frameDelayMs = Math.max(10, Math.floor(milliseconds / (frameCount * 10)) * 10);
  return (frameCount - 1) * frameDelayMs;
}

function escapeMacString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\{/g, '\\{')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

function writeTerminal(terminal: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise<void>(resolveWrite => terminal.write(data, resolveWrite));
}

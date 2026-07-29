import type { SpecialKey } from '../lib/types.js';

export const DEMO_RECORDING_VERSION = 1 as const;

export interface DemoRecordingMetadata {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
}

export interface DemoOutputEvent {
  type: 'output';
  atMs: number;
  data: string;
}

export interface DemoInputEvent {
  type: 'input';
  atMs: number;
  data: string;
  specialKey?: SpecialKey;
}

export interface DemoMarkerEvent {
  type: 'marker';
  atMs: number;
  label?: string;
  caption?: string;
  narration?: string;
  audioPath?: string;
  holdMs: number;
}

export interface DemoExitEvent {
  type: 'exit';
  atMs: number;
  exitCode: number | null;
  signal: string | null;
}

export type DemoRecordingEvent = DemoOutputEvent | DemoInputEvent | DemoMarkerEvent | DemoExitEvent;

export interface DemoRecordingCapture {
  input: boolean;
  outputBytes: number;
  droppedOutputBytes: number;
  droppedEvents: number;
  initialOutputTruncated: boolean;
  truncated: boolean;
}

export interface DemoRecording {
  version: typeof DEMO_RECORDING_VERSION;
  metadata: DemoRecordingMetadata;
  capture: DemoRecordingCapture;
  events: DemoRecordingEvent[];
}

export interface DemoRecordingOptions {
  captureInput?: boolean;
  maxEvents?: number;
  maxOutputBytes?: number;
}

export interface DemoMarkerOptions {
  label?: string;
  caption?: string;
  narration?: string;
  audioPath?: string;
  holdMs?: number;
}

export interface DemoRecordingStatus {
  active: boolean;
  startedAt: string;
  elapsedMs: number;
  eventCount: number;
  outputBytes: number;
  captureInput: boolean;
}

export interface DemoRecordingResult {
  path: string;
  durationMs: number;
  eventCount: number;
  outputBytes: number;
  captureInput: boolean;
  truncated: boolean;
}

export interface DemoPollyOptions {
  voiceId: string;
  engine?: 'standard' | 'neural' | 'long-form' | 'generative';
  languageCode?: string;
  profile?: string;
  region?: string;
  awsPath?: string;
}

export type DemoRenderer = 'native' | 'mac';

export type DemoMacTransition =
  | 'crossfade'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'wipe'
  | 'fadeBlack'
  | 'zoom';

export type DemoMacEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface DemoMacOptions {
  executablePath?: string;
  transition?: DemoMacTransition;
  transitionMs?: number;
  easing?: DemoMacEasing;
  captionFontSize?: number;
  narrationPaddingMs?: number;
  programFileName?: string;
}

export interface DemoRenderOptions {
  recording: string | DemoRecording;
  outputPath: string;
  format?: 'mp4' | 'webm';
  renderer?: DemoRenderer;
  fps?: number;
  theme?: 'dark' | 'light';
  title?: string;
  fontSize?: number;
  tailHoldMs?: number;
  captions?: boolean;
  polly?: DemoPollyOptions;
  mac?: DemoMacOptions;
  ffmpegPath?: string;
  ffprobePath?: string;
  narrationOutputPath?: string;
  keepWorkDir?: boolean;
  workDir?: string;
}

export interface DemoRenderResult {
  outputPath: string;
  captionsPath?: string;
  narrationPath?: string;
  visualMasterPath?: string;
  macProgramPath?: string;
  macManifestPath?: string;
  format: 'mp4' | 'webm';
  renderer: DemoRenderer;
  durationMs: number;
  frameCount: number;
  width: number;
  height: number;
  narrationClips: number;
  workDir?: string;
}

export interface PreparedNarrationClip {
  markerIndex: number;
  path: string;
  durationMs: number;
}

export interface DemoTimelineMarker {
  eventIndex: number;
  sourceAtMs: number;
  outputAtMs: number;
  holdMs: number;
  caption?: string;
}

export interface DemoTimeline {
  outputEvents: Array<DemoOutputEvent & { outputAtMs: number }>;
  markers: DemoTimelineMarker[];
  durationMs: number;
}

export interface DemoKeyframe {
  index: number;
  eventIndex: number;
  sourceAtMs: number;
  path: string;
  label?: string;
  caption?: string;
  narration?: string;
  audioPath?: string;
  holdMs: number;
}

export interface DemoKeyframeExportResult {
  keyframes: DemoKeyframe[];
  width: number;
  height: number;
}

export interface DemoMacScene {
  index: number;
  eventIndex: number;
  sourceAtMs: number;
  sourceFrame: string;
  startMs: number;
  holdMs: number;
  label?: string;
  caption?: string;
  narration?: string;
  audioPath?: string;
  transition?: {
    type: DemoMacTransition;
    requestedDurationMs: number;
    renderedDurationMs: number;
    easing: DemoMacEasing;
  };
}

export interface DemoMacManifest {
  version: 1;
  renderer: 'mac';
  width: number;
  height: number;
  durationMs: number;
  frameCount: number;
  program: string;
  visualMaster: string;
  scenes: DemoMacScene[];
}

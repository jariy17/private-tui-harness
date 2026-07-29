import type {
  DemoExitEvent,
  DemoInputEvent,
  DemoMarkerEvent,
  DemoMarkerOptions,
  DemoOutputEvent,
  DemoRecording,
  DemoRecordingEvent,
  DemoRecordingMetadata,
  DemoRecordingOptions,
  DemoRecordingResult,
  DemoRecordingStatus,
} from './types.js';
import { DEMO_RECORDING_VERSION } from './types.js';
import type { SpecialKey } from '../lib/types.js';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { performance } from 'perf_hooks';

const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface InitialOutput {
  data: string;
  droppedBytes: number;
}

export interface DemoRecorderDependencies {
  now?: () => number;
}

export class DemoRecorder {
  private readonly metadata: DemoRecordingMetadata;
  private readonly captureInput: boolean;
  private readonly maxEvents: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private readonly startMs: number;
  private readonly initialOutputTruncated: boolean;
  private readonly events: DemoRecordingEvent[] = [];
  private outputBytes = 0;
  private droppedOutputBytes = 0;
  private droppedEvents = 0;
  private stopped = false;

  constructor(
    metadata: DemoRecordingMetadata,
    initialOutput: InitialOutput,
    options: DemoRecordingOptions = {},
    dependencies: DemoRecorderDependencies = {}
  ) {
    this.metadata = metadata;
    this.captureInput = options.captureInput ?? false;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error(`maxEvents must be a positive integer; received ${this.maxEvents}.`);
    }
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new Error(`maxOutputBytes must be a positive integer; received ${this.maxOutputBytes}.`);
    }
    this.now = dependencies.now ?? performance.now.bind(performance);
    this.startMs = this.now();
    this.droppedOutputBytes = initialOutput.droppedBytes;
    this.initialOutputTruncated = initialOutput.droppedBytes > 0;

    if (initialOutput.data.length > 0) {
      this.recordOutputAt(initialOutput.data, 0);
    }
  }

  get status(): DemoRecordingStatus {
    return {
      active: !this.stopped,
      startedAt: this.metadata.startedAt,
      elapsedMs: this.elapsedMs(),
      eventCount: this.events.length,
      outputBytes: this.outputBytes,
      captureInput: this.captureInput,
    };
  }

  recordOutput(data: string): void {
    this.assertActive();
    this.recordOutputAt(data, this.elapsedMs());
  }

  recordInput(data: string, specialKey?: SpecialKey): void {
    this.assertActive();
    if (!this.captureInput) {
      return;
    }

    const event: DemoInputEvent = {
      type: 'input',
      atMs: this.elapsedMs(),
      data,
      ...(specialKey ? { specialKey } : {}),
    };
    this.pushEvent(event);
  }

  mark(options: DemoMarkerOptions): DemoMarkerEvent {
    this.assertActive();
    const marker: DemoMarkerEvent = {
      type: 'marker',
      atMs: this.elapsedMs(),
      ...(options.label ? { label: options.label } : {}),
      ...(options.caption ? { caption: options.caption } : {}),
      ...(options.narration ? { narration: options.narration } : {}),
      ...(options.audioPath ? { audioPath: resolve(options.audioPath) } : {}),
      holdMs: options.holdMs ?? 0,
    };

    if (!marker.label && !marker.caption && !marker.narration && !marker.audioPath && marker.holdMs === 0) {
      throw new Error('A recording marker must include a label, caption, narration, audioPath, or holdMs.');
    }

    if (!this.pushEvent(marker)) {
      throw new Error(`Recording event limit (${this.maxEvents}) reached; marker was not captured.`);
    }
    return marker;
  }

  recordExit(exitCode: number | null, signal: string | null): void {
    if (this.stopped || this.events.some(event => event.type === 'exit')) {
      return;
    }
    const event: DemoExitEvent = {
      type: 'exit',
      atMs: this.elapsedMs(),
      exitCode,
      signal,
    };
    this.pushEvent(event);
  }

  stop(exit?: { exitCode: number | null; signal: string | null }): DemoRecording {
    this.assertActive();
    if (exit) {
      this.recordExit(exit.exitCode, exit.signal);
    }
    this.stopped = true;
    return this.snapshot();
  }

  private recordOutputAt(data: string, atMs: number): void {
    const bytes = Buffer.byteLength(data);
    if (this.outputBytes + bytes > this.maxOutputBytes) {
      this.droppedOutputBytes += bytes;
      this.droppedEvents += 1;
      return;
    }

    const event: DemoOutputEvent = {
      type: 'output',
      atMs,
      data,
    };
    if (this.pushEvent(event)) {
      this.outputBytes += bytes;
    } else {
      this.droppedOutputBytes += bytes;
    }
  }

  private pushEvent(event: DemoRecordingEvent): boolean {
    if (this.events.length >= this.maxEvents) {
      this.droppedEvents += 1;
      return false;
    }
    this.events.push(event);
    return true;
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(this.now() - this.startMs));
  }

  private snapshot(): DemoRecording {
    return {
      version: DEMO_RECORDING_VERSION,
      metadata: {
        ...this.metadata,
        args: [...this.metadata.args],
      },
      capture: {
        input: this.captureInput,
        outputBytes: this.outputBytes,
        droppedOutputBytes: this.droppedOutputBytes,
        droppedEvents: this.droppedEvents,
        initialOutputTruncated: this.initialOutputTruncated,
        truncated: this.droppedOutputBytes > 0 || this.droppedEvents > 0,
      },
      events: this.events.map(event => ({ ...event })),
    };
  }

  private assertActive(): void {
    if (this.stopped) {
      throw new Error('Recording has already stopped.');
    }
  }
}

export async function saveDemoRecording(recording: DemoRecording, path: string): Promise<DemoRecordingResult> {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(recording, null, 2)}\n`, 'utf-8');

  const durationMs = recording.events.reduce((maximum, event) => Math.max(maximum, event.atMs), 0);
  return {
    path: resolvedPath,
    durationMs,
    eventCount: recording.events.length,
    outputBytes: recording.capture.outputBytes,
    captureInput: recording.capture.input,
    truncated: recording.capture.truncated,
  };
}

export async function readDemoRecording(path: string): Promise<DemoRecording> {
  const resolvedPath = resolve(path);
  const parsed = JSON.parse(await readFile(resolvedPath, 'utf-8')) as unknown;
  assertDemoRecording(parsed, resolvedPath);
  return parsed;
}

export function assertDemoRecording(value: unknown, source = 'recording'): asserts value is DemoRecording {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid demo recording in ${source}: expected an object.`);
  }

  const candidate = value as Partial<DemoRecording>;
  if (candidate.version !== DEMO_RECORDING_VERSION) {
    throw new Error(
      `Unsupported demo recording version in ${source}: expected ${DEMO_RECORDING_VERSION}, received ${String(candidate.version)}.`
    );
  }
  if (!candidate.metadata || !candidate.capture || !Array.isArray(candidate.events)) {
    throw new Error(`Invalid demo recording in ${source}: metadata, capture, and events are required.`);
  }

  const { metadata } = candidate;
  if (
    typeof metadata.command !== 'string' ||
    !Array.isArray(metadata.args) ||
    !metadata.args.every(argument => typeof argument === 'string') ||
    typeof metadata.cwd !== 'string' ||
    !Number.isInteger(metadata.cols) ||
    !Number.isInteger(metadata.rows) ||
    typeof metadata.startedAt !== 'string'
  ) {
    throw new Error(`Invalid demo recording metadata in ${source}.`);
  }

  const { capture } = candidate;
  if (
    typeof capture.input !== 'boolean' ||
    !isNonNegativeInteger(capture.outputBytes) ||
    !isNonNegativeInteger(capture.droppedOutputBytes) ||
    !isNonNegativeInteger(capture.droppedEvents) ||
    typeof capture.initialOutputTruncated !== 'boolean' ||
    typeof capture.truncated !== 'boolean'
  ) {
    throw new Error(`Invalid demo recording capture metadata in ${source}.`);
  }

  let previousAtMs = -1;
  for (const rawEvent of candidate.events as unknown[]) {
    if (!rawEvent || typeof rawEvent !== 'object') {
      throw new Error(`Invalid demo recording event in ${source}.`);
    }
    const event = rawEvent as Record<string, unknown>;
    if (typeof event.type !== 'string' || typeof event.atMs !== 'number') {
      throw new Error(`Invalid demo recording event in ${source}.`);
    }
    if (!Number.isFinite(event.atMs) || event.atMs < 0 || event.atMs < previousAtMs) {
      throw new Error(`Demo recording events in ${source} must have ascending non-negative timestamps.`);
    }
    previousAtMs = event.atMs;

    if (event.type === 'output' || event.type === 'input') {
      if (typeof event.data !== 'string') {
        throw new Error(`Invalid ${event.type} event in ${source}: data must be a string.`);
      }
    } else if (event.type === 'marker') {
      if (typeof event.holdMs !== 'number' || !Number.isFinite(event.holdMs) || event.holdMs < 0) {
        throw new Error(`Invalid marker event in ${source}: holdMs must be non-negative.`);
      }
      for (const field of ['label', 'caption', 'narration', 'audioPath'] as const) {
        if (event[field] !== undefined && typeof event[field] !== 'string') {
          throw new Error(`Invalid marker event in ${source}: ${field} must be a string.`);
        }
      }
    } else if (event.type === 'exit') {
      if (
        (event.exitCode !== null && typeof event.exitCode !== 'number') ||
        (event.signal !== null && typeof event.signal !== 'string')
      ) {
        throw new Error(`Invalid exit event in ${source}.`);
      }
    } else if (event.type !== 'exit') {
      throw new Error(
        `Invalid demo recording event type in ${source}: ${String(event.type)}.`
      );
    }
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

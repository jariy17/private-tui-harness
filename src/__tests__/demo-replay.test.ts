import { buildDemoTimeline, captionAt, replayDemoFrames } from '../demo/replay.js';
import type { DemoRecording } from '../demo/types.js';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const recording: DemoRecording = {
  version: 1,
  metadata: {
    command: 'demo',
    args: [],
    cwd: '/tmp',
    cols: 40,
    rows: 10,
    startedAt: '2026-07-29T00:00:00.000Z',
  },
  capture: {
    input: false,
    outputBytes: 2,
    droppedOutputBytes: 0,
    droppedEvents: 0,
    initialOutputTruncated: false,
    truncated: false,
  },
  events: [
    { type: 'output', atMs: 0, data: 'A' },
    { type: 'marker', atMs: 100, caption: 'Explain A.', narration: 'Explain A.', holdMs: 500 },
    { type: 'output', atMs: 200, data: 'B' },
    { type: 'exit', atMs: 300, exitCode: 0, signal: null },
  ],
};

describe('demo replay', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('inserts narration-length holds and shifts later output deterministically', () => {
    const timeline = buildDemoTimeline(
      recording,
      [{ markerIndex: 1, path: '/tmp/narration.mp3', durationMs: 800 }],
      1000
    );

    expect(timeline.markers).toEqual([
      {
        eventIndex: 1,
        sourceAtMs: 100,
        outputAtMs: 100,
        holdMs: 800,
        caption: 'Explain A.',
      },
    ]);
    expect(timeline.outputEvents.map(event => event.outputAtMs)).toEqual([0, 1000]);
    expect(timeline.durationMs).toBe(2100);
    expect(captionAt(timeline, 100)).toBe('Explain A.');
    expect(captionAt(timeline, 2100)).toBeUndefined();
  });

  it('renders a complete fixed-rate PNG sequence', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tui-demo-replay-'));
    const framesDir = join(tempDir, 'frames');
    const timeline = buildDemoTimeline(recording, [], 500);
    const result = await replayDemoFrames(recording, timeline, {
      framesDir,
      fps: 2,
      theme: 'dark',
      title: 'Demo',
      captions: true,
    });

    const files = (await readdir(framesDir)).sort();
    expect(files).toHaveLength(result.frameCount);
    expect(files[0]).toBe('frame-00000001.png');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);

    const firstFrame = await readFile(join(framesDir, files[0]!));
    const lastFrame = await readFile(join(framesDir, files.at(-1)!));
    expect(firstFrame.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(lastFrame.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});

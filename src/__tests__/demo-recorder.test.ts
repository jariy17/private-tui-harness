import { DemoRecorder, assertDemoRecording, readDemoRecording, saveDemoRecording } from '../demo/recorder.js';
import type { DemoRecordingMetadata } from '../demo/types.js';
import { TuiSession } from '../lib/tui-session.js';
import { isAvailable } from '../lib/availability.js';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const metadata: DemoRecordingMetadata = {
  command: '/bin/sh',
  args: [],
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  startedAt: '2026-07-29T00:00:00.000Z',
};

describe('DemoRecorder', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('records monotonic output and markers while excluding input by default', async () => {
    let now = 1000;
    const recorder = new DemoRecorder(
      metadata,
      { data: 'READY\r\n', droppedBytes: 4 },
      {},
      { now: () => now }
    );

    now = 1025;
    recorder.recordInput('secret');
    recorder.recordOutput('NEXT\r\n');
    now = 1050;
    recorder.mark({ label: 'next', caption: 'The next screen.', holdMs: 500 });
    const recording = recorder.stop({ exitCode: 0, signal: null });

    expect(recording.events).toEqual([
      { type: 'output', atMs: 0, data: 'READY\r\n' },
      { type: 'output', atMs: 25, data: 'NEXT\r\n' },
      {
        type: 'marker',
        atMs: 50,
        label: 'next',
        caption: 'The next screen.',
        holdMs: 500,
      },
      { type: 'exit', atMs: 50, exitCode: 0, signal: null },
    ]);
    expect(recording.capture).toMatchObject({
      input: false,
      initialOutputTruncated: true,
      droppedOutputBytes: 4,
      truncated: true,
    });

    tempDir = await mkdtemp(join(tmpdir(), 'tui-demo-recorder-'));
    const path = join(tempDir, 'nested', 'demo.json');
    const result = await saveDemoRecording(recording, path);
    const loaded = await readDemoRecording(path);

    expect(result).toMatchObject({ path, durationMs: 50, eventCount: 4, captureInput: false });
    expect(loaded).toEqual(recording);
    expect((await readFile(path, 'utf-8')).endsWith('\n')).toBe(true);
  });

  it('captures input only when enabled and reports bounded output truncation', () => {
    let now = 0;
    const recorder = new DemoRecorder(
      metadata,
      { data: '12345', droppedBytes: 0 },
      { captureInput: true, maxOutputBytes: 5, maxEvents: 3 },
      { now: () => now }
    );

    now = 10;
    recorder.recordInput('\r', 'enter');
    recorder.recordOutput('overflow');
    const recording = recorder.stop();

    expect(recording.events).toContainEqual({
      type: 'input',
      atMs: 10,
      data: '\r',
      specialKey: 'enter',
    });
    expect(recording.capture).toMatchObject({
      input: true,
      outputBytes: 5,
      droppedOutputBytes: 8,
      droppedEvents: 1,
      initialOutputTruncated: false,
      truncated: true,
    });
  });

  it('rejects unsupported recording versions', () => {
    expect(() => assertDemoRecording({ version: 999 })).toThrow(/Unsupported demo recording version/);
  });

  it('rejects invalid recorder limits and malformed capture metadata', () => {
    expect(() => new DemoRecorder(metadata, { data: '', droppedBytes: 0 }, { maxEvents: 0 })).toThrow(
      /maxEvents must be a positive integer/
    );
    expect(() =>
      assertDemoRecording({
        version: 1,
        metadata,
        capture: { input: 'yes' },
        events: [],
      })
    ).toThrow(/Invalid demo recording capture metadata/);
  });
});

describe.skipIf(!isAvailable)('TuiSession demo recording', () => {
  let session: TuiSession | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('captures the settled initial screen and subsequent PTY output', async () => {
    const script = "stty -echo; printf 'READY\\n'; IFS= read -r value; printf 'DONE\\n'; IFS= read -r finish";
    session = await TuiSession.launch({ command: '/bin/sh', args: ['-c', script], cols: 80, rows: 24 });
    session.startDemoRecording();
    session.markDemoRecording({ caption: 'Ready to continue.', holdMs: 200 });
    await session.sendKeys('not-recorded\r');
    await session.waitFor('DONE', 2000);

    tempDir = await mkdtemp(join(tmpdir(), 'tui-demo-session-'));
    const path = join(tempDir, 'recording.json');
    await session.stopDemoRecording(path);
    const recording = await readDemoRecording(path);

    expect(recording.events.filter(event => event.type === 'input')).toHaveLength(0);
    expect(
      recording.events
        .filter(event => event.type === 'output')
        .map(event => event.data)
        .join('')
    ).toContain('READY');
    expect(
      recording.events
        .filter(event => event.type === 'output')
        .map(event => event.data)
        .join('')
    ).toContain('DONE');
  });
});

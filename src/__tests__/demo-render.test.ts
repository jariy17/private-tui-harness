import { encodeDemoVideo, probeMediaDuration } from '../demo/ffmpeg.js';
import { buildPollyArgs } from '../demo/narration.js';
import { renderDemo } from '../demo/render.js';
import type { DemoRecording } from '../demo/types.js';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
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
    outputBytes: 5,
    droppedOutputBytes: 0,
    droppedEvents: 0,
    initialOutputTruncated: false,
    truncated: false,
  },
  events: [
    { type: 'output', atMs: 0, data: 'READY' },
    { type: 'marker', atMs: 100, caption: 'Ready to deploy.', holdMs: 200 },
    { type: 'exit', atMs: 200, exitCode: 0, signal: null },
  ],
};

describe('demo media integration', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('builds Polly arguments without invoking a shell', () => {
    expect(
      buildPollyArgs('Deploy the agent.', '/tmp/voice.mp3', {
        voiceId: 'Joanna',
        engine: 'neural',
        profile: 'deploy',
        region: 'us-west-2',
      })
    ).toEqual([
      'polly',
      'synthesize-speech',
      '--output-format',
      'mp3',
      '--voice-id',
      'Joanna',
      '--text-type',
      'text',
      '--text',
      'Deploy the agent.',
      '--engine',
      'neural',
      '--profile',
      'deploy',
      '--region',
      'us-west-2',
      '/tmp/voice.mp3',
    ]);
  });

  it('probes media duration and constructs a timed FFmpeg mix', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tui-demo-media-'));
    const ffprobePath = join(tempDir, 'ffprobe');
    const ffmpegPath = join(tempDir, 'ffmpeg');
    const argsPath = join(tempDir, 'ffmpeg-args.txt');
    const outputPath = join(tempDir, 'demo.mp4');

    await writeExecutable(ffprobePath, "#!/bin/sh\nprintf '1.250\\n'\n");
    await writeExecutable(
      ffmpegPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nfor last do :; done\nprintf 'video' > "$last"\n`
    );

    expect(await probeMediaDuration(join(tempDir, 'voice.mp3'), ffprobePath)).toBe(1250);

    await encodeDemoVideo({
      framesPattern: join(tempDir, 'frame-%08d.png'),
      fps: 30,
      outputPath,
      format: 'mp4',
      durationMs: 2500,
      audioClips: [{ path: join(tempDir, 'voice.mp3'), startMs: 750 }],
      ffmpegPath,
    });

    const args = await readFile(argsPath, 'utf-8');
    expect(args).toContain('adelay=750:all=1');
    expect(args).toContain('amix=inputs=1');
    expect(args).toContain('normalize=0');
    expect(args).toContain('loudnorm=I=-16');
    expect(args).toContain('libx264');
    expect(await readFile(outputPath, 'utf-8')).toBe('video');
  });

  it('renders frames, a video artifact, and sidecar captions end to end', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tui-demo-render-'));
    const ffmpegPath = join(tempDir, 'ffmpeg');
    const argsPath = join(tempDir, 'render-args.txt');
    const outputPath = join(tempDir, 'walkthrough.mp4');
    await writeExecutable(
      ffmpegPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nfor last do :; done\nprintf 'video' > "$last"\n`
    );

    const result = await renderDemo({
      recording,
      outputPath,
      fps: 2,
      tailHoldMs: 300,
      ffmpegPath,
      keepWorkDir: true,
    });

    expect(result).toMatchObject({
      outputPath,
      format: 'mp4',
      durationMs: 700,
      frameCount: 2,
      narrationClips: 0,
    });
    expect(result.workDir).toBeDefined();
    expect(await readFile(outputPath, 'utf-8')).toBe('video');
    expect(await readFile(join(tempDir, 'walkthrough.srt'), 'utf-8')).toContain('Ready to deploy.');
    expect(await readFile(argsPath, 'utf-8')).toContain('frame-%08d.png');
  });

  it('renders semantic keyframes through a generated Mac program', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tui-demo-mac-'));
    const macPath = join(tempDir, 'mac');
    const ffmpegPath = join(tempDir, 'ffmpeg');
    const argsPath = join(tempDir, 'ffmpeg-args.txt');
    const workDir = join(tempDir, 'work');
    const outputPath = join(tempDir, 'walkthrough.mp4');

    await writeExecutable(
      macPath,
      `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.MAC_OUTPUT_DIR;
const harnessManifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));
const outputDir = join(root, 'visual-frames');
const durations = [200, 70, 70, 70, 70, 70, 70, 500];
mkdirSync(outputDir, { recursive: true });
const frames = durations.map((durationMs, index) => {
  const path = \`frame-\${String(index + 1).padStart(6, '0')}.png\`;
  writeFileSync(join(outputDir, path), 'png');
  return { path, durationMs };
});
writeFileSync(
  join(outputDir, 'manifest.json'),
  JSON.stringify({
    version: 1,
    format: 'mac-frame-sequence',
    width: harnessManifest.width,
    height: harnessManifest.height,
    frames,
  })
);
`
    );
    await writeExecutable(
      ffmpegPath,
      `#!/bin/sh
printf '%s\\n' "$@" > '${argsPath}'
for last do :; done
printf 'video' > "$last"
`
    );
    const macRecording: DemoRecording = {
      ...recording,
      events: [
        ...recording.events.slice(0, 2),
        { type: 'output', atMs: 150, data: '\r\nDONE' },
        { type: 'marker', atMs: 200, caption: 'Deployment complete.', holdMs: 200 },
        { type: 'exit', atMs: 250, exitCode: 0, signal: null },
      ],
    };

    const result = await renderDemo({
      recording: macRecording,
      outputPath,
      renderer: 'mac',
      fps: 24,
      tailHoldMs: 300,
      workDir,
      mac: {
        executablePath: relative(process.cwd(), macPath),
        programFileName: 'walkthrough.mac',
      },
      ffmpegPath,
    });

    expect(result).toMatchObject({
      outputPath,
      renderer: 'mac',
      durationMs: 1120,
      frameCount: 8,
      narrationClips: 0,
      macProgramPath: join(workDir, 'walkthrough.mac'),
      macManifestPath: join(workDir, 'manifest.json'),
      visualMasterPath: join(workDir, 'visual-frames', 'manifest.json'),
    });
    const program = await readFile(join(workDir, 'walkthrough.mac'), 'utf-8');
    expect(program).toContain('@"source-frames/001-marker-1.png"');
    expect(program).toContain('bottom: "Ready to deploy."');
    expect(program).toContain('--- crossfade 500ms easeInOut ---');
    expect(program).toContain('bottom: "Deployment complete."');
    expect(program).toContain('walkthrough.saveFrames("visual-frames")');
    const manifest = JSON.parse(await readFile(join(workDir, 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      renderer: 'mac',
      durationMs: 1120,
      frameCount: 8,
      scenes: [
        { sourceFrame: 'source-frames/001-marker-1.png', holdMs: 200 },
        { sourceFrame: 'source-frames/002-marker-3.png', holdMs: 500 },
      ],
    });
    const frameManifest = JSON.parse(
      await readFile(join(workDir, 'visual-frames', 'manifest.json'), 'utf-8')
    );
    expect(frameManifest.format).toBe('mac-frame-sequence');
    expect(frameManifest.frames.map((frame: { durationMs: number }) => frame.durationMs)).toEqual([
      200, 70, 70, 70, 70, 70, 70, 500,
    ]);
    const concat = await readFile(join(workDir, 'visual-frames', 'frames.ffconcat'), 'utf-8');
    expect(concat).toContain("file 'frame-000001.png'");
    expect(concat).toContain('duration 0.200');
    expect(await readFile(argsPath, 'utf-8')).toContain('frames.ffconcat');
    expect(await readFile(argsPath, 'utf-8')).not.toContain('.gif');
    expect(await readFile(outputPath, 'utf-8')).toBe('video');
  });
});

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf-8');
  await chmod(path, 0o755);
}

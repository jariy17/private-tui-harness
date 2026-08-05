import {
  DEFAULT_NARRATION_TAIL_PADDING_MS,
  DEFAULT_NARRATION_TARGET_LUFS,
  DEFAULT_POLLY_ENGINE,
  DEFAULT_POLLY_VOICE_ID,
  buildNarratedVideoArgs,
  buildPollyArgs,
  narrateVideo,
} from '../lib/video-narration.js';
import { describe, expect, it } from 'vitest';

describe('video narration', () => {
  it('builds a default Joanna neural Polly request', () => {
    expect(buildPollyArgs('Deploy the agent.', '/tmp/narration.mp3')).toEqual([
      'polly',
      'synthesize-speech',
      '--output-format',
      'mp3',
      '--voice-id',
      DEFAULT_POLLY_VOICE_ID,
      '--engine',
      DEFAULT_POLLY_ENGINE,
      '--text-type',
      'text',
      '--text',
      'Deploy the agent.',
      '/tmp/narration.mp3',
    ]);
  });

  it('supports alternate voices, engines, profiles, regions, and SSML', () => {
    expect(
      buildPollyArgs('<speak>Hello.</speak>', '/tmp/ruth.mp3', {
        voiceId: 'Ruth',
        engine: 'generative',
        textType: 'ssml',
        languageCode: 'en-US',
        profile: 'deploy',
        region: 'us-west-2',
      })
    ).toEqual([
      'polly',
      'synthesize-speech',
      '--output-format',
      'mp3',
      '--voice-id',
      'Ruth',
      '--engine',
      'generative',
      '--text-type',
      'ssml',
      '--text',
      '<speak>Hello.</speak>',
      '--language-code',
      'en-US',
      '--profile',
      'deploy',
      '--region',
      'us-west-2',
      '/tmp/ruth.mp3',
    ]);
  });

  it('extends a short video to preserve the full narration and tail', () => {
    const { args, outputDurationMs } = buildNarratedVideoArgs(
      '/tmp/input.mp4',
      '/tmp/narration.mp3',
      '/tmp/output.mp4',
      {
        videoDurationMs: 5_000,
        narrationDurationMs: 8_000,
      }
    );
    const command = args.join(' ');

    expect(outputDurationMs).toBe(8_000 + DEFAULT_NARRATION_TAIL_PADDING_MS);
    expect(command).toContain('tpad=stop_mode=clone:stop_duration=3.500');
    expect(command).toContain(`loudnorm=I=${DEFAULT_NARRATION_TARGET_LUFS}:LRA=11:TP=-1.5`);
    expect(command).toContain('apad=pad_dur=0.500');
    expect(command).toContain('-c:v libx264');
    expect(command).toContain('-t 8.500');
  });

  it('pads short narration without re-encoding a longer video', () => {
    const { args, outputDurationMs } = buildNarratedVideoArgs(
      '/tmp/input.mp4',
      '/tmp/narration.mp3',
      '/tmp/output.mp4',
      {
        videoDurationMs: 10_000,
        narrationDurationMs: 4_000,
        tailPaddingMs: 1_000,
        targetLufs: -18,
      }
    );
    const command = args.join(' ');

    expect(outputDurationMs).toBe(10_000);
    expect(command).not.toContain('tpad=');
    expect(command).toContain('loudnorm=I=-18:LRA=11:TP=-1.5');
    expect(command).toContain('apad=pad_dur=6.000');
    expect(command).toContain('-c:a aac -ar 48000 -b:a 192k');
    expect(command).toContain('-c:v copy');
    expect(command).toContain('-t 10.000');
  });

  it.each([
    [{ videoDurationMs: 0, narrationDurationMs: 1_000 }, 'Video duration'],
    [{ videoDurationMs: 1_000, narrationDurationMs: Number.NaN }, 'Narration duration'],
  ])('rejects invalid media timing', (timing, message) => {
    expect(() =>
      buildNarratedVideoArgs('/tmp/input.mp4', '/tmp/narration.mp3', '/tmp/output.mp4', timing)
    ).toThrow(message);
  });

  it('rejects empty narration before invoking external tools', async () => {
    await expect(
      narrateVideo({
        videoPath: '/tmp/input.mp4',
        outputPath: '/tmp/output.mp4',
        narration: '   ',
      })
    ).rejects.toThrow('Narration must not be empty');
  });

  it('rejects conflicting video and audio output paths', async () => {
    await expect(
      narrateVideo({
        videoPath: '/tmp/input.mp4',
        outputPath: '/tmp/output.mp4',
        audioOutputPath: '/tmp/./output.mp4',
        narration: 'Deploy the agent.',
      })
    ).rejects.toThrow('Video and audio output paths must be different');
  });

  it('rejects an audio output path that would overwrite the source video', async () => {
    await expect(
      narrateVideo({
        videoPath: '/tmp/input.mp4',
        outputPath: '/tmp/output.mp4',
        audioOutputPath: '/tmp/./input.mp4',
        narration: 'Deploy the agent.',
      })
    ).rejects.toThrow('Source video and audio output paths must be different');
  });
});

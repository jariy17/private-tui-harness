# TUI Demo Recording

TUI Harness can capture a real PTY session as a versioned recording and replay it deterministically into a captioned MP4 or WebM. Recording and rendering are separate so a walkthrough can be rerendered with a different theme, title, frame rate, voice, or output format without driving the product again.

## Requirements

- Node.js 20 or newer
- `ffmpeg` for video encoding
- `ffprobe` when a marker uses narration audio
- Optional: [Mac (Meme as Code)](https://github.com/jona62/mac) for semantic scene composition
- Optional: AWS CLI and Amazon Polly permissions for synthesized narration

The FFmpeg tools must be visible in the MCP server's `PATH`, or their paths must be supplied with `ffmpegPath` and `ffprobePath`.

## MCP Workflow

1. Launch and settle the product with `tui_launch`.
2. Call `tui_record_start`. Existing terminal output is captured at time zero so the initial screen can be reconstructed.
3. Drive and validate the TUI normally.
4. Call `tui_record_mark` whenever a meaningful screen is visible.
5. Call `tui_record_stop` to save the JSON artifact.
6. Close the TUI session.
7. Call `tui_demo_render` to produce the video.

```json
{
  "sessionId": "SESSION_ID",
  "caption": "Choose where the agent will run.",
  "narration": "First, choose the environment where the agent will run.",
  "holdMs": 1200
}
```

A marker can contain:

| Field | Purpose |
|---|---|
| `label` | Internal step name stored in the recording |
| `caption` | Visible text rendered below the terminal |
| `narration` | Script synthesized with Polly, and the fallback caption |
| `audioPath` | Existing audio used instead of synthesized speech |
| `holdMs` | Minimum time to freeze the marked screen |

Narration duration automatically extends the marker hold. Later terminal output is shifted by the inserted hold, preserving the interaction order.

## CLI Rendering

```bash
npx tui-harness-mcp render-demo ./demo.recording.json \
  --output ./demo.mp4 \
  --title "AgentCore CLI" \
  --fps 30
```

Polly narration:

```bash
npx tui-harness-mcp render-demo ./demo.recording.json \
  --output ./demo.mp4 \
  --polly-voice Joanna \
  --polly-engine neural \
  --aws-profile deploy
```

Mac-authored visual timeline:

```bash
npx tui-harness-mcp render-demo ./demo.recording.json \
  --output ./demo.mp4 \
  --renderer mac \
  --mac-path /path/to/mac \
  --work-dir ./demo-mac \
  --polly-voice Joanna \
  --polly-engine neural \
  --aws-profile deploy \
  --narration-output ./demo-joanna.wav
```

Use a durable `--work-dir` with the Mac renderer. It preserves the source terminal PNGs, generated `.mac` program, timing manifest, synthesized clips, and Mac visual master.

Use `npx tui-harness-mcp render-demo --help` for all render options.

## Library API

```typescript
import { TuiSession, renderDemo } from 'tui-harness-mcp';

const session = await TuiSession.launch({
  command: 'my-tui',
  cols: 100,
  rows: 30,
});

session.startDemoRecording();
session.markDemoRecording({
  caption: 'Review the deployment plan.',
  narration: 'Review the plan before starting the deployment.',
  holdMs: 1000,
});

const recording = await session.stopDemoRecording('./demo.recording.json');
await session.close();

const video = await renderDemo({
  recording: recording.path,
  outputPath: './demo.mp4',
  renderer: 'mac',
  title: 'Deployment walkthrough',
  workDir: './demo-mac',
  mac: {
    executablePath: '/path/to/mac',
  },
});
```

## Recording Format

The JSON artifact contains:

- `version`: recording schema version
- `metadata`: command, arguments, working directory, terminal dimensions, and start time
- `capture`: input-capture setting, byte counts, and truncation state
- `events`: monotonic `output`, optional `input`, `marker`, and `exit` events

Output is bounded to 50 MiB and 100,000 events. The capture metadata reports dropped bytes or events. The pre-recording screen buffer is bounded to 1 MiB.

Input capture is disabled by default. Enabling it stores raw typed text and special-key sequences. This can capture credentials and pasted secrets. It does not affect playback because video replay is based on PTY output.

## Rendering Details

The `native` renderer replays output through `@xterm/headless`, uses the harness SVG renderer for each frame, rasterizes SVG with `@resvg/resvg-js`, and encodes the PNG sequence with FFmpeg.

The `mac` renderer replays output only to semantic markers and exports one source PNG per marker. It generates a Mac program that owns caption composition, frame holds, and transitions, then invokes Mac to create `visual-master.gif`. FFmpeg converts that Mac output to MP4 or WebM and muxes narration. The generated manifest records exact scene starts, quantized GIF holds, transition timing, and narration alignment.

- MP4 uses H.264 and AAC.
- WebM uses VP9 and Opus.
- Narration is mixed without per-input attenuation and normalized to -16 LUFS.
- Captions are baked into the frame and emitted as a sidecar `.srt`.
- Existing audio files and synthesized Polly clips can be mixed on one timeline.
- `keepWorkDir` retains frames and generated audio for diagnosis.
- Mac GIFs are limited to 500 total keyframes and interpolated transition frames. The renderer validates the limit before invoking Mac.

External voice models can generate marker-level files referenced by `audioPath`. Confirm that a model is text-to-speech before using it for narration; automatic speech recognition models such as Whisper transcribe audio and cannot synthesize a voice.

The recording contains process output and local path metadata. Review it before sharing outside its intended audience.

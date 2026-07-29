---
name: tui-demo-video
description: Create polished TUI walkthroughs, narrated terminal demos, and product demo videos with the tui-harness MCP tools. Use when an agent needs to plan, record, caption, narrate, render, or verify an MP4 or WebM demonstration of a terminal user interface.
---

# TUI Demo Video

Create a deterministic video from real TUI interactions. Treat the recording as a product walkthrough: validate each state, mark only meaningful screens, keep narration concise, and verify the rendered artifact.

## Prerequisites

Confirm these before recording:

- The `tui-harness` MCP server exposes `tui_record_start`, `tui_record_mark`, `tui_record_stop`, and `tui_demo_render`.
- `ffmpeg` and `ffprobe` are available to the MCP server process.
- Polished semantic walkthroughs require a local Mac (Meme as Code) executable.
- Amazon Polly narration requires the AWS CLI, valid credentials, and an explicit `pollyVoiceId`.
- Existing narration files must be readable by the MCP server.

Use a durable output directory, not `/tmp`, unless the user explicitly wants temporary artifacts.

## Plan The Storyboard

Write a short internal storyboard before launching:

1. Identify the initial state and the user outcome.
2. Keep one product idea per marked screen.
3. Specify the expected screen text before each action.
4. Draft captions and narration in plain spoken language.
5. Decide whether each screen needs a minimum hold.

Aim for narration that explains why the action matters rather than reading every visible label. Prefer 1-2 sentences per marker.

## Record The Flow

1. Launch the TUI with fixed `cols` and `rows`.
2. Start recording with `captureInput: false`.
3. Wait for and validate the first meaningful state.
4. Mark the visible screen with its caption, narration, audio, or hold.
5. Perform the next action with `tui_action` when possible so the expected transition is validated in the same call.
6. Repeat marking and acting until the outcome is visible.
7. Stop and save the recording before closing the session.
8. Close the session.

Place a marker after the screen it describes is fully visible and before sending the next action. Rendering freezes that screen for `holdMs`; narration audio automatically extends the freeze when it runs longer.

Example sequence:

```text
tui_launch(command, args, cwd, cols=100, rows=30)
tui_record_start(sessionId, captureInput=false)
tui_wait_for(sessionId, pattern="Select an environment")
tui_record_mark(
  sessionId,
  label="environment",
  caption="Choose the environment for this deployment.",
  narration="First, choose the environment where the agent will run.",
  holdMs=1200
)
tui_action(sessionId, specialKey="down", pattern="Production")
...
tui_record_stop(sessionId, savePath="/durable/path/demo.recording.json")
tui_close(sessionId)
```

## Protect Secrets

Keep `captureInput` disabled unless typed input is itself necessary evidence and contains no credentials, tokens, personal data, or sensitive values. Input capture is raw and can include escape sequences and pasted text.

Disabling input capture does not hide secrets rendered by the TUI. Use test data, redacted values, or a safe test account so sensitive content never appears on screen.

## Add Narration

Choose one narration source per marker:

- Set `audioPath` to use a prepared audio file.
- Set `narration` and pass `pollyVoiceId` to `tui_demo_render` to synthesize speech with Amazon Polly.
- Set `narration` without a voice to use the text as a visible caption only.

When both `audioPath` and `narration` are present, the audio file supplies sound and the narration text supplies the default caption. Keep voice, engine, and writing style consistent across markers.

For AWS testing in Aidan's environment, use `awsProfile: "deploy"` unless the user specifies another profile.

## Render

Use `renderer: "mac"` for product tours built around meaningful TUI states. Mac must own scene composition, captions, holds, and transitions; FFmpeg only encodes the Mac visual master and muxes audio. Set `workDir` to a durable directory so the `.mac` source, manifest, source frames, and visual master remain available.

Use `renderer: "native"` only when continuous typing, spinners, streaming output, or cursor motion is itself important to the story. This preserves every PTY update.

Render to MP4 for broad compatibility or WebM for web-native delivery:

```text
tui_demo_render(
  recordingPath="/durable/path/demo.recording.json",
  outputPath="/durable/path/demo.mp4",
  renderer="mac",
  macPath="/path/to/mac",
  workDir="/durable/path/demo-mac",
  title="AgentCore CLI",
  fps=30,
  theme="dark",
  captions=true,
  pollyVoiceId="Joanna",
  pollyEngine="neural",
  awsProfile="deploy"
)
```

Mac transitions are rendered at 15 fps and the visual master has a 500-frame limit including interpolated transition frames. Prefer 400-800ms transitions and one frame per semantic state. Do not pass thousands of duplicated native frames through Mac.

Captions are baked into a fixed footer and also written as a sidecar SRT file. Use `narrationOutputPath` to keep a normalized standalone audio track.

For voice comparisons, render the same recording and visual timeline with identical narration text. Keep Amazon Polly available as one provider and supply alternate TTS output through marker `audioPath` values. Normalize both assembled tracks to the same loudness before judging quality. Verify that an external endpoint is text-to-speech; Whisper and other automatic speech recognition models cannot generate narration.

## Verify

Do not report success from the tool response alone:

1. Confirm the video and optional SRT exist and are non-empty.
2. Use `ffprobe` to verify duration, video codec, dimensions, frame rate, and audio stream presence when narration was requested.
3. Check that duration includes every narration clip and the final hold.
4. For Mac renders, inspect the generated `.mac` program and manifest and confirm `visual-master.gif` came from Mac.
5. Inspect representative frames from the beginning, each marked transition, and the end.
6. Confirm captions fit, terminal text is legible, no secret is visible, and the demonstrated outcome is clear.

If the render fails, retain the work directory, inspect the generated PNG sequence and synthesized audio, fix the recording or render options, and rerender from the same recording artifact.

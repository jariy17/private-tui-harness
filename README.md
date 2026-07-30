# tui-harness-mcp

MCP server for programmatically driving any TUI application via headless pseudo-terminals. A "headless browser" for terminal apps.

## What it does

Spawns any command in a pseudo-terminal, pipes its output through a headless xterm emulator, and exposes tools to send keystrokes, read the screen, wait for patterns, take screenshots, and create narrated walkthrough videos - all via the [Model Context Protocol](https://modelcontextprotocol.io).

Works with any TUI: vim, htop, lazygit, Ink apps, custom CLIs, etc.

## Quick Start

```bash
npm install
npm run build

# Start the MCP server (HTTP mode, port 24100)
npm start

# Or use stdio mode
npm run start:stdio
```

### Configure Claude Code

```bash
claude mcp add --transport http -s project tui-harness http://127.0.0.1:24100/mcp
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "tui-harness": {
      "type": "http",
      "url": "http://127.0.0.1:24100/mcp"
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `tui_launch` | Spawn a TUI process in a PTY. Returns session ID and initial screen. |
| `tui_send_keys` | Send text or special keys (enter, tab, ctrl+c, arrows, etc.). |
| `tui_action` | Composite: send keys + wait for pattern + read screen in one call. |
| `tui_read_screen` | Read the current terminal screen content. |
| `tui_wait_for` | Wait for text/regex to appear on screen. |
| `tui_screenshot` | Capture text, self-contained SVG, or deterministic PNG. Optionally write it to disk. |
| `tui_record_start` | Start capturing timestamped PTY output and semantic markers. |
| `tui_record_mark` | Add a caption, narration cue, audio cue, or timed hold. |
| `tui_record_stop` | Stop recording and save a versioned JSON artifact. |
| `tui_demo_render` | Replay a recording into a captioned or narrated MP4/WebM. |
| `tui_close` | Close a session and terminate its process. |
| `tui_list_sessions` | List retained sessions and their current liveness. |

### Interaction defaults

- Sessions use a 140x40 terminal viewport unless `cols` or `rows` is provided.
- Key sends wait for 100ms of text silence before returning. Cosmetic writes such as cursor blinking do not reset the timer.
- Pattern waits time out after 10 seconds unless `timeoutMs` is provided.
- Up to 10 live processes may run concurrently. Exited sessions remain available for final-screen inspection until closed, but do not consume the live-session quota.
- `tui_screenshot.savePath` writes the screenshot to the requested path and overwrites an existing file.
- SVG and PNG screenshots use a packaged 16px DejaVu Sans Mono profile and high-contrast ANSI palette, so font metrics and raster output do not depend on the host's installed fonts.
- `tui_screenshot` accepts `theme`, `fontSize`, `showWindowChrome`, and `title` for visual output. PNG responses include an MCP image unless `returnContent` is false.
- Demo input capture is disabled by default. Save an active recording before closing its session.
- Narration audio automatically extends a marked hold so speech is never cut short.

## Library Usage

The harness can also be used as a Node.js library:

```typescript
import { DARK_THEME, TuiSession } from 'tui-harness-mcp';

const session = await TuiSession.launch({
  command: 'vim',
  args: ['test.txt'],
  cols: 140,
  rows: 40,
});

// Wait for vim to load
await session.waitFor('test.txt');

// Type some text
await session.sendKeys('iHello, world!');
await session.sendSpecialKey('escape');

// Read the screen
const screen = session.readScreen();
console.log(screen.lines.join('\n'));

// Take an SVG screenshot
const svg = session.screenshot({ theme: DARK_THEME });

// Or rasterize the same terminal profile as PNG
const { png, width, height } = session.screenshotPng({
  theme: DARK_THEME,
  showWindowChrome: false,
});

// Record a reusable walkthrough artifact
session.startDemoRecording();
session.markDemoRecording({
  caption: 'Review the deployment plan.',
  narration: 'Review the plan before starting the deployment.',
  holdMs: 1000,
});
const recording = await session.stopDemoRecording('./demo.recording.json');

// Clean up
await session.close();
```

## Architecture

```
src/
├── index.ts              # Library barrel export
├── lib/
│   ├── types.ts          # Interfaces, error classes, key types
│   ├── tui-session.ts    # Core session: PTY + xterm + DSR handling
│   ├── screen.ts         # Screen buffer reading utilities
│   ├── settling.ts       # Output settling detection
│   ├── key-map.ts        # Special key → escape sequence mapping
│   ├── svg-renderer.ts   # Terminal → SVG rendering
│   ├── terminal-profile.ts # Themes, fonts, and terminal cell metrics
│   ├── terminal-rasterizer.ts # Deterministic SVG → PNG rendering
│   ├── font-assets.ts    # Packaged font loading and SVG embedding
│   ├── session-manager.ts # Global session registry + cleanup
│   └── availability.ts   # node-pty availability check
├── demo/
│   ├── recorder.ts       # Versioned, bounded recording artifacts
│   ├── replay.ts         # Deterministic timeline and frame replay
│   ├── mac.ts            # Semantic keyframes and Mac program generation
│   ├── rasterizer.ts     # SVG to PNG conversion
│   ├── narration.ts      # Existing audio and Amazon Polly
│   ├── ffmpeg.ts         # Media probing and video encoding
│   └── render.ts         # End-to-end render orchestration
├── mcp/
│   ├── index.ts          # CLI entry point (HTTP or stdio)
│   ├── launchd.ts        # launchd environment and plist helpers
│   ├── server.ts         # MCP tool registration and handlers
│   ├── http-server.ts    # Streamable HTTP transport
│   └── tools.ts          # Tool name constants and defaults
└── web/
    ├── routes.ts         # Browser console API
    └── security.ts       # Loopback Host and same-origin validation
```

### Key Design Decisions

- **`node-pty`** spawns real PTY processes — TUI apps behave identically to running in a real terminal
- **`@xterm/headless`** maintains a virtual screen buffer, so screen reads are instant (no scraping)
- **DSR/CPR handler** intercepts cursor position queries so TUI frameworks like Ink don't hang
- **Settling monitor** compares text snapshots to detect when rendering is complete, filtering out cursor blink noise
- **Terminal visual profiles** keep font metrics, ANSI palettes, cursor rendering, SVG output, and PNG output consistent across hosts
- **Bundled font faces** remove system-font substitution while retaining system fonts only as fallback for glyphs outside DejaVu's coverage
- **HTTP transport** recommended for Claude Code (stdio transport blocks PTY spawning inside the sandbox)
- **Exited-session retention** keeps final screens inspectable without reducing the live-session allowance
- **Raw PTY recordings** preserve real rendering behavior while semantic markers control captions, narration, and pacing
- **Deterministic replay** reconstructs every frame through xterm and renders it with the existing SVG terminal renderer

## Demo Videos

Install FFmpeg, then record a flow through the MCP tools:

1. `tui_launch`
2. `tui_record_start`
3. Drive the product and call `tui_record_mark` on meaningful screens
4. `tui_record_stop`
5. `tui_close`
6. `tui_demo_render`

The recording JSON is independent from the video. Rerender it with a different theme, title, frame rate, voice, or output format without running the TUI again.

Two visual renderers are available:

- `native` replays every PTY update for full-motion terminal video.
- `mac` exports each semantic marker as a terminal keyframe, then uses [Mac (Meme as Code)](https://github.com/jona62/mac) to compose captions, holds, and transitions as lossless PNG frames. FFmpeg encodes that Mac-authored frame sequence and muxes narration.

Render an existing recording from the command line:

```bash
npx tui-harness-mcp render-demo ./demo.recording.json \
  --output ./demo.mp4 \
  --title "Product walkthrough"
```

Render a polished semantic walkthrough through Mac and preserve its source:

```bash
npx tui-harness-mcp render-demo ./demo.recording.json \
  --output ./demo.mp4 \
  --renderer mac \
  --mac-path /path/to/mac \
  --work-dir ./demo-mac \
  --polly-voice Joanna \
  --polly-engine neural \
  --aws-profile deploy
```

The durable work directory contains `source-frames/`, the generated `.mac` program, `manifest.json`, synthesized narration clips, and `visual-frames/` with lossless PNGs, per-frame timing, and the FFmpeg concat input.

Use an existing audio file in a marker, or synthesize every marker's `narration` text with Amazon Polly:

```bash
npx tui-harness-mcp render-demo ./demo.recording.json \
  --output ./demo.mp4 \
  --polly-voice Joanna \
  --polly-engine neural \
  --aws-profile deploy
```

Captions are visible in a fixed footer and are also written to a sidecar SRT file. See [docs/demo-recording.md](docs/demo-recording.md) for the recording format, security guidance, and full API.

## Transport Modes

### HTTP (Recommended)

Runs as an independent process. PTY spawning works normally.

```bash
node dist/mcp/index.js --http --port 24100
```

The HTTP server also provides a web console at `http://127.0.0.1:24100/`.

### Local security model

The HTTP server is intentionally a local automation service:

- It binds only to `127.0.0.1`.
- It accepts only loopback `Host` headers.
- Browser requests must use an exact same-origin loopback `Origin`.
- The console API does not emit wildcard CORS headers.

There is no token authentication. Local processes are inside the trust boundary because the service can launch commands and send input to active terminals. Do not expose the server through a reverse proxy, port forward, or non-loopback listener.

### Stdio

For automated pipelines where no sandbox restrictions apply. PTY spawning will fail inside Claude Code's sandbox.

```bash
node dist/mcp/index.js
```

## Running as a macOS Service (launchd)

For persistent operation, install as a launchd service that starts on login and auto-restarts on crash:

```bash
npx tui-harness-mcp install-launchd
```

This will:
- Generate a plist at `~/Library/LaunchAgents/tui_harness_mcp_launch.plist` with your current node path and project location
- Preserve the installer's current `PATH`, while adding standard system fallback directories
- Load the service immediately
- Print the `claude mcp add` command to register it in Claude Code

### Managing the service

```bash
launchctl stop tui_harness_mcp_launch        # stop
launchctl start tui_harness_mcp_launch       # start
launchctl unload ~/Library/LaunchAgents/tui_harness_mcp_launch.plist  # disable
launchctl load ~/Library/LaunchAgents/tui_harness_mcp_launch.plist    # re-enable
tail -f ~/Library/Logs/tui-harness.stderr.log  # watch logs
```

## Using with Claude Code

### Register as a global MCP server

After the server is running (via launchd or manually), register it so every Claude Code session can use the TUI tools:

```bash
claude mcp add --transport http -s user tui-harness http://127.0.0.1:24100/mcp
```

### Verify it works

In a Claude Code session, the `tui_*` tools should be available. Test with:

```
tui_list_sessions
```

If you get `Session not found` errors after restarting the server, restart Claude Code or run `/mcp` to reconnect.

## TUI Flow Executor Agent

The server ships with a Claude Code agent that can execute multi-step TUI flows autonomously. A parent agent describes an expected flow (screens, actions, transitions), and the Haiku-powered sub-agent drives the TUI harness, validates each step, captures screenshots on screen changes, and produces a markdown report.

### Install the agent

```bash
npx tui-harness-mcp install-all
```

This installs the Claude Code flow executor and the `tui-demo-video` skill for both Codex and Claude Code. Use `install-agent` or `install-skill` to install only one component.

### How it works

A parent agent spawns the `tui-flow-executor` sub-agent via the Agent tool with `model: "haiku"`. The sub-agent:

1. Launches the TUI command via `tui_launch`
2. Steps through the expected flow, verifying each screen matches before acting
3. Screenshots on screen/window transitions (not every keystroke)
4. If the flow deviates from expectations — stops immediately and reports what went wrong
5. Writes a markdown report with embedded SVG screenshots to the specified output directory
6. Returns a concise summary to the parent agent

### Example

```
Agent({
  model: "haiku",
  subagent_type: "tui-flow-executor",
  description: "Run deploy flow",
  prompt: `Execute this TUI flow:
    Command: my-cli deploy
    Steps:
    1. EXPECT "Select environment" → send DOWN DOWN ENTER
    2. EXPECT "Confirm?" → send "y" ENTER
    3. EXPECT "Deploy complete"
    Output directory: /tmp/deploy-report`
})
```

Returns:
```
STATUS: SUCCESS
STEPS_COMPLETED: 3/3
REPORT: /tmp/deploy-report/report.md
SCREENSHOTS: /tmp/deploy-report/screenshots/
```

## Requirements

- Node.js >= 20
- A C++ toolchain for `node-pty` native compilation (Xcode CLI tools on macOS, build-essential on Linux)
- FFmpeg for demo video rendering
- Optional: Mac (Meme as Code) for semantic scene composition
- Optional: AWS CLI and Amazon Polly access for synthesized narration

## Development

```bash
npm ci
npm test
```

The test command builds the package first, then covers PTY/xterm integration, MCP tool behavior, screenshot output, session lifecycle, demo recording and replay, web-console cleanup, request security, launchd configuration, and packaged CLI execution.

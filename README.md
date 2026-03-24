# tui-harness-mcp

MCP server for programmatically driving any TUI application via headless pseudo-terminals. A "headless browser" for terminal apps.

## What it does

Spawns any command in a pseudo-terminal, pipes its output through a headless xterm emulator, and exposes tools to send keystrokes, read the screen, wait for patterns, and take screenshots — all via the [Model Context Protocol](https://modelcontextprotocol.io).

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
| `tui_screenshot` | Capture a text or SVG screenshot. Optionally save to disk. |
| `tui_close` | Close a session and terminate its process. |
| `tui_list_sessions` | List all active sessions. |

## Library Usage

The harness can also be used as a Node.js library:

```typescript
import { TuiSession } from 'tui-harness-mcp';

const session = await TuiSession.launch({
  command: 'vim',
  args: ['test.txt'],
  cols: 120,
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
│   ├── session-manager.ts # Global session registry + cleanup
│   └── availability.ts   # node-pty availability check
└── mcp/
    ├── index.ts          # CLI entry point (HTTP or stdio)
    ├── server.ts         # MCP tool registration and handlers
    ├── http-server.ts    # Streamable HTTP transport
    └── tools.ts          # Tool name constants and defaults
```

### Key Design Decisions

- **`node-pty`** spawns real PTY processes — TUI apps behave identically to running in a real terminal
- **`@xterm/headless`** maintains a virtual screen buffer, so screen reads are instant (no scraping)
- **DSR/CPR handler** intercepts cursor position queries so TUI frameworks like Ink don't hang
- **Settling monitor** compares text snapshots to detect when rendering is complete, filtering out cursor blink noise
- **HTTP transport** recommended for Claude Code (stdio transport blocks PTY spawning inside the sandbox)

## Transport Modes

### HTTP (Recommended)

Runs as an independent process. PTY spawning works normally.

```bash
node dist/mcp/index.js --http --port 24100
```

### Stdio

For automated pipelines where no sandbox restrictions apply. PTY spawning will fail inside Claude Code's sandbox.

```bash
node dist/mcp/index.js
```

## TUI Flow Executor Agent

The server ships with a Claude Code agent that can execute multi-step TUI flows autonomously. A parent agent describes an expected flow (screens, actions, transitions), and the Haiku-powered sub-agent drives the TUI harness, validates each step, captures screenshots on screen changes, and produces a markdown report.

### Install the agent

```bash
npx tui-harness-mcp install-agent
```

This copies the agent definition to `~/.claude/agents/tui-flow-executor.md`, making it available globally in Claude Code.

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

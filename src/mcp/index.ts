#!/usr/bin/env node

import { startHttpServer } from './http-server.js';
import { buildLaunchdPath, escapePlistValue } from './launchd.js';
import { closeAllSessions, createServer } from './server.js';
import { renderDemo } from '../demo/render.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cpSync, existsSync, mkdirSync, writeFileSync, writeSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';

const DEFAULT_PORT = 24100;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

interface TransportConfig {
  mode: 'stdio' | 'http';
  port: number;
}

function projectRoot(): string {
  const filename = fileURLToPath(import.meta.url);
  return resolve(dirname(filename), '..', '..');
}

/**
 * Parses CLI arguments and environment variables to determine transport mode and port.
 *
 * Flags:
 *   --http              Use HTTP transport instead of stdio
 *   --port <number>     Port for HTTP transport (default: 24100)
 *
 * Environment variables:
 *   MCP_HARNESS_TRANSPORT   Set to 'http' for HTTP mode
 *   MCP_HARNESS_PORT        Port for HTTP transport
 */
function parseArgs(): TransportConfig {
  const args = process.argv.slice(2);

  const httpFlagPresent = args.includes('--http');
  const envTransport = process.env.MCP_HARNESS_TRANSPORT;
  const mode: 'stdio' | 'http' = httpFlagPresent || envTransport === 'http' ? 'http' : 'stdio';

  let port = DEFAULT_PORT;

  const portFlagIndex = args.indexOf('--port');
  if (portFlagIndex !== -1) {
    const portArg = args[portFlagIndex + 1];
    if (portArg === undefined) {
      console.error('Error: --port flag requires a value.');
      process.exit(1);
    }
    port = parsePort(portArg);
  } else if (process.env.MCP_HARNESS_PORT !== undefined) {
    port = parsePort(process.env.MCP_HARNESS_PORT);
  }

  return { mode, port };
}

function parsePort(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    console.error(`Error: Invalid port "${value}". Must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    process.exit(1);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// install-agent subcommand
// ---------------------------------------------------------------------------

function installAgent(): void {
  const source = join(projectRoot(), 'agents', 'tui-flow-executor.md');

  if (!existsSync(source)) {
    console.error(`Error: Agent file not found at ${source}`);
    process.exit(1);
  }

  const targetDir = join(homedir(), '.claude', 'agents');
  const target = join(targetDir, 'tui-flow-executor.md');

  mkdirSync(targetDir, { recursive: true });
  cpSync(source, target);

  printLine('Installed tui-flow-executor agent to ~/.claude/agents/tui-flow-executor.md');
  printLine();
  printLine('The agent is now available globally in Claude Code.');
  printLine('Use it by spawning a sub-agent with subagent_type: "tui-flow-executor"');
}

// ---------------------------------------------------------------------------
// install-skill and install-all subcommands
// ---------------------------------------------------------------------------

function installSkill(): void {
  const source = join(projectRoot(), 'skills', 'tui-demo-video');
  if (!existsSync(source)) {
    console.error(`Error: Skill directory not found at ${source}`);
    process.exit(1);
  }

  const codexRoot = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const targets = [
    join(codexRoot, 'skills', 'tui-demo-video'),
    join(claudeRoot, 'skills', 'tui-demo-video'),
  ];

  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }

  printLine('Installed tui-demo-video skill to:');
  printLine(`  ${targets[0]}`);
  printLine(`  ${targets[1]}`);
}

function installAll(): void {
  installAgent();
  printLine();
  installSkill();
}

// ---------------------------------------------------------------------------
// render-demo subcommand
// ---------------------------------------------------------------------------

async function renderDemoCommand(args: string[]): Promise<void> {
  if (args.includes('--help')) {
    printRenderHelp();
    return;
  }

  const recordingPath = args[1];
  if (!recordingPath || recordingPath.startsWith('--')) {
    failCli('render-demo requires a recording JSON path.');
  }

  const outputPath = flagValue(args, '--output');
  if (!outputPath) {
    failCli('render-demo requires --output <video.mp4|video.webm>.');
  }

  const format = optionalEnum(flagValue(args, '--format'), '--format', ['mp4', 'webm'] as const);
  const renderer = optionalEnum(flagValue(args, '--renderer'), '--renderer', ['native', 'mac'] as const);
  const theme = optionalEnum(flagValue(args, '--theme'), '--theme', ['dark', 'light'] as const);
  const pollyEngine = optionalEnum(flagValue(args, '--polly-engine'), '--polly-engine', [
    'standard',
    'neural',
    'long-form',
    'generative',
  ] as const);
  const pollyVoiceId = flagValue(args, '--polly-voice');
  const macTransition = optionalEnum(flagValue(args, '--mac-transition'), '--mac-transition', [
    'crossfade',
    'slideLeft',
    'slideRight',
    'slideUp',
    'slideDown',
    'wipe',
    'fadeBlack',
    'zoom',
  ] as const);
  const macEasing = optionalEnum(flagValue(args, '--mac-easing'), '--mac-easing', [
    'linear',
    'easeIn',
    'easeOut',
    'easeInOut',
  ] as const);

  const result = await renderDemo({
    recording: recordingPath,
    outputPath,
    format,
    renderer,
    fps: optionalNumber(flagValue(args, '--fps'), '--fps'),
    theme,
    title: flagValue(args, '--title'),
    fontSize: optionalNumber(flagValue(args, '--font-size'), '--font-size'),
    tailHoldMs: optionalNumber(flagValue(args, '--tail-hold-ms'), '--tail-hold-ms'),
    captions: !args.includes('--no-captions'),
    ...(pollyVoiceId
      ? {
          polly: {
            voiceId: pollyVoiceId,
            engine: pollyEngine,
            profile: flagValue(args, '--aws-profile'),
            region: flagValue(args, '--aws-region'),
          },
        }
      : {}),
    ...(renderer === 'mac'
      ? {
          mac: {
            executablePath: flagValue(args, '--mac-path'),
            transition: macTransition,
            transitionMs: optionalNumber(flagValue(args, '--mac-transition-ms'), '--mac-transition-ms'),
            easing: macEasing,
            captionFontSize: optionalNumber(
              flagValue(args, '--mac-caption-font-size'),
              '--mac-caption-font-size'
            ),
            narrationPaddingMs: optionalNumber(
              flagValue(args, '--mac-narration-padding-ms'),
              '--mac-narration-padding-ms'
            ),
            programFileName: flagValue(args, '--mac-program'),
          },
        }
      : {}),
    ffmpegPath: flagValue(args, '--ffmpeg'),
    ffprobePath: flagValue(args, '--ffprobe'),
    narrationOutputPath: flagValue(args, '--narration-output'),
    keepWorkDir: args.includes('--keep-work-dir'),
    workDir: flagValue(args, '--work-dir'),
  });

  printLine(`Rendered ${result.format.toUpperCase()} demo with ${result.renderer}: ${result.outputPath}`);
  printLine(`Duration: ${result.durationMs}ms | Frames: ${result.frameCount} | Size: ${result.width}x${result.height}`);
  if (result.captionsPath) {
    printLine(`Captions: ${result.captionsPath}`);
  }
  if (result.narrationClips > 0) {
    printLine(`Narration clips: ${result.narrationClips}`);
  }
  if (result.narrationPath) {
    printLine(`Narration track: ${result.narrationPath}`);
  }
  if (result.macProgramPath) {
    printLine(`Mac program: ${result.macProgramPath}`);
    printLine(`Mac manifest: ${result.macManifestPath}`);
    printLine(`Mac visual master: ${result.visualMasterPath}`);
  }
  if (result.workDir) {
    printLine(`Work directory: ${result.workDir}`);
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    failCli(`${flag} requires a value.`);
  }
  return value;
}

function optionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    failCli(`${flag} must be a number; received "${value}".`);
  }
  return parsed;
}

function optionalEnum<const T extends readonly string[]>(
  value: string | undefined,
  flag: string,
  allowed: T
): T[number] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value)) {
    failCli(`${flag} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

function failCli(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function printRenderHelp(): void {
  writeSync(1, `Usage: tui-harness-mcp render-demo <recording.json> --output <demo.mp4|demo.webm> [options]

Options:
  --format <mp4|webm>       Override the output format
  --renderer <native|mac>   Full-motion native replay or semantic Mac composition
  --fps <1-60>              Frames per second (default: 30)
  --theme <dark|light>      Terminal theme (default: dark)
  --title <text>            Window title
  --font-size <pixels>      Terminal font size (default: 16)
  --tail-hold-ms <ms>       Final screen hold (default: 1000)
  --no-captions             Disable visible captions and SRT output
  --polly-voice <voice>     Synthesize marker narration with Amazon Polly
  --polly-engine <engine>   standard, neural, long-form, or generative
  --aws-profile <profile>   AWS CLI profile for Polly
  --aws-region <region>     AWS region for Polly
  --narration-output <path> Write the normalized narration track (.wav/.mp3/.m4a)
  --mac-path <path>         Mac (Meme as Code) executable
  --mac-transition <type>   Mac scene transition (default: crossfade)
  --mac-transition-ms <ms>  Mac transition duration (default: 500)
  --mac-easing <easing>     linear, easeIn, easeOut, or easeInOut
  --mac-caption-font-size <pixels>
                            Mac caption font size (default: 24)
  --mac-narration-padding-ms <ms>
                            Silence after each narration clip (default: 300)
  --mac-program <name.mac>  Generated Mac filename (default: demo.mac)
  --ffmpeg <path>           FFmpeg executable
  --ffprobe <path>          ffprobe executable
  --keep-work-dir           Retain generated frames and audio
  --work-dir <path>         Use a specific work directory
  --help                    Show this help
`);
}

function printLine(message = ''): void {
  writeSync(1, `${message}\n`);
}

// ---------------------------------------------------------------------------
// install-launchd subcommand
// ---------------------------------------------------------------------------

function installLaunchd(): void {
  if (platform() !== 'darwin') {
    console.error('Error: launchd is macOS-only. On Linux, use systemd or run the server directly.');
    process.exit(1);
  }

  const nodePath = process.execPath;
  const root = projectRoot();
  const entryPoint = join(root, 'dist', 'mcp', 'index.js');
  const home = homedir();
  const user = process.env.USER ?? 'unknown';
  // launchd does not load the user's shell profile, so preserve the PATH from installation.
  const launchdPath = buildLaunchdPath(nodePath);

  if (!existsSync(entryPoint)) {
    console.error(`Error: Entry point not found at ${entryPoint}. Run npm run build first.`);
    process.exit(1);
  }

  const label = 'tui_harness_mcp_launch';
  const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const logsDir = join(home, 'Library', 'Logs');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapePlistValue(nodePath)}</string>
        <string>${escapePlistValue(entryPoint)}</string>
        <string>--http</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${escapePlistValue(root)}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${escapePlistValue(logsDir)}/tui-harness.stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${escapePlistValue(logsDir)}/tui-harness.stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapePlistValue(launchdPath)}</string>
        <key>HOME</key>
        <string>${escapePlistValue(home)}</string>
        <key>USER</key>
        <string>${escapePlistValue(user)}</string>
        <key>SHELL</key>
        <string>/bin/zsh</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>`;

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, 'utf-8');

  // Unload previous version, then load new one
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // May not exist yet
  }
  execSync(`launchctl load "${plistPath}"`);

  printLine(`Installed launchd service: ${label}`);
  printLine(`  Plist: ${plistPath}`);
  printLine(`  Logs:  ${logsDir}/tui-harness.stderr.log`);
  printLine();
  printLine('The server will start on login and auto-restart on crash.');
  printLine();
  printLine('Register it in Claude Code:');
  printLine(`  claude mcp add --transport http -s user tui-harness http://127.0.0.1:${DEFAULT_PORT}/mcp`);
  printLine();
  printLine('Manage the service:');
  printLine(`  launchctl stop ${label}`);
  printLine(`  launchctl start ${label}`);
  printLine(`  launchctl unload "${plistPath}"`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'install-agent') {
    installAgent();
    return;
  }

  if (command === 'install-skill') {
    installSkill();
    return;
  }

  if (command === 'install-all') {
    installAll();
    return;
  }

  if (command === 'render-demo') {
    await renderDemoCommand(args);
    return;
  }

  if (command === 'install-launchd') {
    installLaunchd();
    return;
  }

  const { mode, port } = parseArgs();

  if (mode === 'http') {
    await startHttpServer(port);
    return;
  }

  // Stdio mode (default)
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await closeAllSessions();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('TUI harness MCP server failed to start:', error);
  process.exit(1);
});

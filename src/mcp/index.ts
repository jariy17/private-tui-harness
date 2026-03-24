import { startHttpServer } from './http-server.js';
import { closeAllSessions, createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'fs';
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
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // In dist: dist/mcp/index.js → project root is ../..
  const projectRoot = resolve(__dirname, '..', '..');
  const source = join(projectRoot, 'agents', 'tui-flow-executor.md');

  if (!existsSync(source)) {
    console.error(`Error: Agent file not found at ${source}`);
    process.exit(1);
  }

  const targetDir = join(homedir(), '.claude', 'agents');
  const target = join(targetDir, 'tui-flow-executor.md');

  mkdirSync(targetDir, { recursive: true });
  cpSync(source, target);

  console.log('Installed tui-flow-executor agent to ~/.claude/agents/tui-flow-executor.md');
  console.log('');
  console.log('The agent is now available globally in Claude Code.');
  console.log('Use it by spawning a sub-agent with subagent_type: "tui-flow-executor"');
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
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const projectRoot = resolve(__dirname, '..', '..');
  const entryPoint = join(projectRoot, 'dist', 'mcp', 'index.js');
  const home = homedir();
  const user = process.env.USER ?? 'unknown';
  const nodeDir = dirname(nodePath);

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
        <string>${nodePath}</string>
        <string>${entryPoint}</string>
        <string>--http</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${logsDir}/tui-harness.stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${logsDir}/tui-harness.stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${nodeDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>USER</key>
        <string>${user}</string>
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

  console.log(`Installed launchd service: ${label}`);
  console.log(`  Plist: ${plistPath}`);
  console.log(`  Logs:  ${logsDir}/tui-harness.stderr.log`);
  console.log('');
  console.log('The server will start on login and auto-restart on crash.');
  console.log('');
  console.log('Register it in Claude Code:');
  console.log(`  claude mcp add --transport http -s user tui-harness http://127.0.0.1:${DEFAULT_PORT}/mcp`);
  console.log('');
  console.log('Manage the service:');
  console.log(`  launchctl stop ${label}`);
  console.log(`  launchctl start ${label}`);
  console.log(`  launchctl unload "${plistPath}"`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('install-agent')) {
    installAgent();
    return;
  }

  if (args.includes('install-launchd')) {
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

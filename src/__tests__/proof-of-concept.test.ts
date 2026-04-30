/**
 * Proof-of-concept tests for @xterm/headless and node-pty integration.
 *
 * These tests verify the foundational import patterns and wiring that the
 * entire TUI harness depends on.
 *
 * --- Import patterns ---
 *
 * @xterm/headless (CJS bundle, no ESM exports map):
 *   import xtermHeadless from '@xterm/headless';
 *   const { Terminal } = xtermHeadless;
 *
 * node-pty (CJS native addon):
 *   import * as pty from 'node-pty';
 *
 * --- xterm.write() is ASYNC ---
 *
 * terminal.write(data) does not synchronously update the buffer. Use the
 * callback form or wrap in a promise:
 *   await new Promise<void>(resolve => terminal.write('hello', resolve));
 *
 * --- allowProposedApi: true is REQUIRED ---
 *
 * Accessing terminal.buffer and terminal.parser requires allowProposedApi.
 *
 * --- node-pty spawn requires real executables ---
 *
 * node-pty uses posix_spawnp. Shell built-ins like `echo` are not standalone
 * executables and will cause "posix_spawnp failed". Use `/bin/echo` instead.
 */
import { createTempDir } from '../helpers.js';
import xtermHeadless from '@xterm/headless';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as pty from 'node-pty';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const { Terminal } = xtermHeadless;

let ptyAvailable = true;
try {
  const p = pty.spawn('/bin/echo', ['test'], { cols: 80, rows: 24 });
  p.kill();
} catch {
  ptyAvailable = false;
}

// ---------------------------------------------------------------------------
// Test A: xterm standalone
// ---------------------------------------------------------------------------
describe('xterm standalone', () => {
  let terminal: InstanceType<typeof Terminal>;

  afterEach(() => {
    terminal?.dispose();
  });

  it('creates a terminal and reads back written text', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

    await new Promise<void>(resolve => terminal.write('hello', resolve));

    const line = terminal.buffer.active.getLine(0)?.translateToString(true);
    expect(line).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// Test B: PTY + xterm wiring
// ---------------------------------------------------------------------------
describe.skipIf(!ptyAvailable)('PTY + xterm wiring', () => {
  let terminal: InstanceType<typeof Terminal>;
  let ptyProcess: ReturnType<typeof pty.spawn> | undefined;

  afterEach(() => {
    ptyProcess?.kill();
    ptyProcess = undefined;
    terminal?.dispose();
  });

  it('pipes PTY output through xterm and reads the buffer', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

    ptyProcess = pty.spawn('/bin/echo', ['hello'], {
      cols: 80,
      rows: 24,
    });

    const exitPromise = new Promise<void>(resolve => {
      ptyProcess!.onData((data: string) => {
        terminal.write(data);
      });
      ptyProcess!.onExit(() => resolve());
    });

    await exitPromise;

    await new Promise<void>(resolve => terminal.write('', resolve));

    const line = terminal.buffer.active.getLine(0)?.translateToString(true);
    expect(line).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// Test C: DSR/CPR handler
// ---------------------------------------------------------------------------
describe.skipIf(!ptyAvailable)('DSR/CPR handler', () => {
  let terminal: InstanceType<typeof Terminal>;
  let ptyProcess: ReturnType<typeof pty.spawn> | undefined;

  afterEach(() => {
    ptyProcess?.kill();
    ptyProcess = undefined;
    terminal?.dispose();
  });

  it('responds to DSR (\\x1b[6n]) with a cursor position report (standalone)', async () => {
    terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });

    let dsrResponse = '';

    terminal.parser.registerCsiHandler({ final: 'n' }, (params: (number | number[])[]) => {
      if (params[0] === 6) {
        const buf = terminal.buffer.active;
        dsrResponse = `\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`;
        return true;
      }
      if (params[0] === 5) {
        dsrResponse = '\x1b[0n';
        return true;
      }
      return false;
    });

    await new Promise<void>(resolve => terminal.write('\x1b[6n', resolve));

    expect(dsrResponse).toBe('\x1b[1;1R');
  });

  it('DSR round-trip through PTY', async () => {
    terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });

    ptyProcess = pty.spawn('/bin/sh', ['-c', 'stty raw -echo; cat'], {
      cols: 80,
      rows: 24,
    });

    let ptyOutput = '';

    ptyProcess.onData((data: string) => {
      ptyOutput += data;
      terminal.write(data);
    });

    terminal.parser.registerCsiHandler({ final: 'n' }, (params: (number | number[])[]) => {
      if (params[0] === 6) {
        const buf = terminal.buffer.active;
        ptyProcess!.write(`\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`);
        return true;
      }
      if (params[0] === 5) {
        ptyProcess!.write('\x1b[0n');
        return true;
      }
      return false;
    });

    await new Promise<void>(resolve => setTimeout(resolve, 200));

    await new Promise<void>(resolve => terminal.write('\x1b[6n', resolve));

    // eslint-disable-next-line no-control-regex
    const cprPattern = /\x1b\[\d+;\d+R/;
    const deadline = Date.now() + 5000;
    while (!cprPattern.test(ptyOutput) && Date.now() < deadline) {
      await new Promise<void>(resolve => terminal.write('', resolve));
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }

    expect(ptyOutput).toMatch(cprPattern);
  });
});

// ---------------------------------------------------------------------------
// Test D: createTempDir helper
// ---------------------------------------------------------------------------
describe('createTempDir', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('creates and cleans up a temporary directory', async () => {
    const result = await createTempDir();
    cleanup = result.cleanup;

    expect(existsSync(result.dir)).toBe(true);

    await result.cleanup();
    cleanup = undefined;
    expect(existsSync(result.dir)).toBe(false);
  });

  it('pre-populates files from the files option', async () => {
    const result = await createTempDir({
      files: {
        'config.json': '{"name":"test"}',
        'nested/dir/file.txt': 'hello',
      },
    });
    cleanup = result.cleanup;

    const configPath = join(result.dir, 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const raw = await readFile(configPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ name: 'test' });

    const nestedPath = join(result.dir, 'nested', 'dir', 'file.txt');
    expect(existsSync(nestedPath)).toBe(true);
    const nestedContent = await readFile(nestedPath, 'utf-8');
    expect(nestedContent).toBe('hello');
  });
});

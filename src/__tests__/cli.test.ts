import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entryPoint = join(projectRoot, 'dist', 'mcp', 'index.js');
const agentSource = join(projectRoot, 'agents', 'tui-flow-executor.md');

describe('npm CLI', () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it('builds an executable entry point with a node shebang', async () => {
    const [entryContent, entryStat] = await Promise.all([readFile(entryPoint, 'utf-8'), stat(entryPoint)]);

    expect(entryContent.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(entryStat.mode & 0o111).not.toBe(0);
  });

  it('runs install-agent through the packaged executable', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'tui-harness-cli-'));

    await execFileAsync(entryPoint, ['install-agent'], {
      env: { ...process.env, HOME: tempHome },
    });

    const installedAgent = join(tempHome, '.claude', 'agents', 'tui-flow-executor.md');
    const [expected, actual] = await Promise.all([
      readFile(agentSource, 'utf-8'),
      readFile(installedAgent, 'utf-8'),
    ]);

    expect(actual).toBe(expected);
  });
});

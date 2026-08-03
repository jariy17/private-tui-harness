import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeAllSessions,
  closeTuiSession,
  createServer,
  getTuiSession,
  listTuiSessions,
} from '../mcp/server.js';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../index.js';
import { createWebConsoleHandler } from '../web/routes.js';

function parseToolResult(result: unknown): Record<string, any> {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('Expected an immediate tool response.');
  }

  const content = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!content || content.type !== 'text' || typeof content.text !== 'string') {
    throw new Error('Expected a text tool response.');
  }
  return JSON.parse(content.text);
}

function createRequest(path: string, method: string): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage;
  request.url = path;
  request.method = method;
  request.headers = { host: '127.0.0.1:24100' };
  return request;
}

function createResponse(): {
  response: ServerResponse;
  status: () => number | undefined;
  headers: () => Record<string, string> | undefined;
  body: () => string;
} {
  let responseStatus: number | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let responseBody = '';

  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      responseStatus = status;
      responseHeaders = headers;
      return this;
    },
    end(data?: string) {
      responseBody = data ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  return {
    response,
    status: () => responseStatus,
    headers: () => responseHeaders,
    body: () => responseBody,
  };
}

describe('MCP server', () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let tempDir: string | undefined;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'tui-harness-test', version: '1.0.0' });
    server = createServer();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await closeAllSessions();
    await client.close();
    await server.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('publishes accurate defaults and filesystem-write annotations', async () => {
    const { tools } = await client.listTools();
    const launch = tools.find(tool => tool.name === 'tui_launch');
    const sendKeys = tools.find(tool => tool.name === 'tui_send_keys');
    const waitFor = tools.find(tool => tool.name === 'tui_wait_for');
    const screenshot = tools.find(tool => tool.name === 'tui_screenshot');
    const launchProperties = launch?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    const sendKeysProperties = sendKeys?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    const waitForProperties = waitFor?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    const screenshotProperties = screenshot?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;

    expect(launchProperties?.cols?.description).toContain(`default: ${DEFAULT_TERMINAL_COLS}`);
    expect(launchProperties?.rows?.description).toContain(`default: ${DEFAULT_TERMINAL_ROWS}`);
    expect(sendKeysProperties?.waitMs?.description).toContain('default: 100');
    expect(waitForProperties?.timeoutMs?.description).toContain('default: 10000');
    expect(screenshotProperties?.pixelRatio?.description).toContain('default: 2');
    expect(screenshot?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('drives a PTY, saves a screenshot, and closes the session', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tui-harness-mcp-'));
    const screenshotPath = join(tempDir, 'screen.svg');
    const pngPath = join(tempDir, 'screen.png');
    const script = `printf 'READY\\n'; IFS= read -r line; printf 'MCP_FLOW:%s\\n' "$line"; IFS= read -r done`;

    const launched = parseToolResult(
      await client.callTool({
        name: 'tui_launch',
        arguments: { command: '/bin/sh', args: ['-c', script], cols: 80, rows: 24 },
      })
    );
    const sessionId = launched.sessionId as string;

    const action = parseToolResult(
      await client.callTool({
        name: 'tui_action',
        arguments: { sessionId, keys: 'hello\r', pattern: 'MCP_FLOW:hello', timeoutMs: 2000 },
      })
    );
    const screenshot = parseToolResult(
      await client.callTool({
        name: 'tui_screenshot',
        arguments: { sessionId, format: 'svg', savePath: screenshotPath, returnContent: false },
      })
    );
    const pngResponse = await client.callTool({
      name: 'tui_screenshot',
      arguments: {
        sessionId,
        format: 'png',
        savePath: pngPath,
        fontSize: 16,
        pixelRatio: 1,
        showWindowChrome: false,
      },
    });
    const png = parseToolResult(pngResponse);

    expect(action).toMatchObject({ found: true, settled: true });
    expect(screenshot).not.toHaveProperty('svg');
    expect(screenshot.savePath).toBe(screenshotPath);
    expect(existsSync(screenshotPath)).toBe(true);
    expect(await readFile(screenshotPath, 'utf-8')).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(png).toMatchObject({
      format: 'png',
      savePath: pngPath,
      metadata: {
        pixels: {
          width: 791,
          height: 524,
        },
      },
    });
    const pngContent = (pngResponse as {
      content: Array<{ type: string; mimeType?: string; data?: string }>;
    }).content;
    const imageContent = pngContent.find(content => content.type === 'image');
    expect(imageContent).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(await readFile(pngPath)).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

    await client.callTool({ name: 'tui_send_keys', arguments: { sessionId, keys: 'done\r' } });
    const closed = parseToolResult(await client.callTool({ name: 'tui_close', arguments: { sessionId } }));

    expect(closed.exitCode).toBe(0);
    expect(listTuiSessions()).toHaveLength(0);
  });

  it('retains exited sessions for inspection without consuming the live-session quota', async () => {
    const sessionIds: string[] = [];

    for (let index = 0; index < 11; index++) {
      const launched = parseToolResult(
        await client.callTool({ name: 'tui_launch', arguments: { command: '/bin/true' } })
      );
      expect(launched.dimensions).toEqual({
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      });
      sessionIds.push(launched.sessionId as string);
    }

    expect(listTuiSessions()).toHaveLength(11);
    expect(listTuiSessions().every(session => !session.alive)).toBe(true);

    for (const sessionId of sessionIds) {
      await client.callTool({ name: 'tui_close', arguments: { sessionId } });
    }
  });

  it('removes sessions closed through the web console and does not emit wildcard CORS', async () => {
    const launched = parseToolResult(
      await client.callTool({ name: 'tui_launch', arguments: { command: '/bin/true' } })
    );
    const sessionId = launched.sessionId as string;
    const handler = createWebConsoleHandler(getTuiSession, listTuiSessions, closeTuiSession);
    const captured = createResponse();

    const handled = await handler(
      createRequest(`/api/sessions/${sessionId}/close`, 'POST'),
      captured.response
    );

    expect(handled).toBe(true);
    expect(captured.status()).toBe(200);
    expect(captured.headers()).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(captured.body())).toMatchObject({ exitCode: 0 });
    expect(getTuiSession(sessionId)).toBeUndefined();
  });
});

import { DARK_THEME, renderTerminalToSvg } from '../lib/svg-renderer.js';
import { rasterizeTerminalSvg, renderTerminalToPng } from '../lib/terminal-rasterizer.js';
import { Resvg } from '@resvg/resvg-js';
import xtermHeadless from '@xterm/headless';
import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

const { Terminal } = xtermHeadless;

describe('terminal rasterizer', () => {
  let terminal: InstanceType<typeof Terminal>;

  afterEach(() => {
    terminal?.dispose();
  });

  it('rasterizes PNG output at 2x pixel density by default', () => {
    const image = rasterizeTerminalSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20"/></svg>'
    );

    expect(image.width).toBe(20);
    expect(image.height).toBe(40);
  });

  it('supports an explicit PNG pixel density', () => {
    const image = rasterizeTerminalSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20"/></svg>',
      { pixelRatio: 1 }
    );

    expect(image.width).toBe(10);
    expect(image.height).toBe(20);
  });

  it('renders deterministic PNG pixels with the bundled font', async () => {
    terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    await new Promise<void>(resolve => {
      terminal.write(
        '\x1b[1;36magentcore\x1b[0m → terminal\n\r\x1b[7m selected \x1b[0m  ─────',
        resolve
      );
    });

    const image = renderTerminalToPng(terminal, {
      showCursor: false,
      showWindowChrome: false,
      fontSize: 14,
    });

    expect(Buffer.from(image.png.subarray(0, 8))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(image.width).toBeGreaterThan(300);
    expect(image.height).toBeGreaterThan(180);
    expect(createHash('sha256').update(image.png).digest('hex')).toBe(
      '1520ff2c2b10d9accbd5f45fed8e3fba2272502541b230c9ec708465b74d8559'
    );
  });

  it('preserves resolved ANSI foreground colors in raster output', async () => {
    terminal = new Terminal({ cols: 8, rows: 2, allowProposedApi: true });
    await new Promise<void>(resolve => {
      terminal.write('\x1b[36m████\x1b[0m', resolve);
    });

    const svg = renderTerminalToSvg(terminal, {
      showCursor: false,
      showWindowChrome: false,
    });
    const pixels = new Resvg(svg).render().pixels;

    expect(containsOpaqueColor(pixels, DARK_THEME.palette[6]!)).toBe(true);
  });
});

function containsOpaqueColor(pixels: Uint8Array, hex: string): boolean {
  const expected = Buffer.from(hex.slice(1), 'hex');

  for (let index = 0; index < pixels.length; index += 4) {
    if (
      pixels[index] === expected[0] &&
      pixels[index + 1] === expected[1] &&
      pixels[index + 2] === expected[2] &&
      pixels[index + 3] === 255
    ) {
      return true;
    }
  }

  return false;
}

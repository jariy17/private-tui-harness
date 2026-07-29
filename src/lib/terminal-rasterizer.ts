import { getBundledTerminalFontFiles } from './font-assets.js';
import { renderTerminalToSvg } from './svg-renderer.js';
import type { SvgRenderOptions } from './svg-renderer.js';
import { Resvg } from '@resvg/resvg-js';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

export interface RasterizedTerminalImage {
  png: Uint8Array;
  width: number;
  height: number;
}

export function rasterizeTerminalSvg(svg: string): RasterizedTerminalImage {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontFiles: getBundledTerminalFontFiles(),
      loadSystemFonts: true,
      defaultFontFamily: 'DejaVu Sans Mono',
      monospaceFamily: 'DejaVu Sans Mono',
    },
    textRendering: 1,
  }).render();

  return {
    png: rendered.asPng(),
    width: rendered.width,
    height: rendered.height,
  };
}

export function renderTerminalToPng(
  terminal: Terminal,
  options?: SvgRenderOptions
): RasterizedTerminalImage {
  const svg = renderTerminalToSvg(terminal, {
    ...options,
    embedFont: false,
  });
  return rasterizeTerminalSvg(svg);
}

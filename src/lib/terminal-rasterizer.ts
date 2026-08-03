import { getBundledTerminalFontFiles } from './font-assets.js';
import { renderTerminalToSvg } from './svg-renderer.js';
import type { SvgRenderOptions } from './svg-renderer.js';
import { Resvg } from '@resvg/resvg-js';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

export const DEFAULT_PNG_PIXEL_RATIO = 2;

export interface RasterizedTerminalImage {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface RasterizeTerminalOptions {
  pixelRatio?: number;
}

export interface PngRenderOptions extends SvgRenderOptions {
  pixelRatio?: number;
}

export function rasterizeTerminalSvg(
  svg: string,
  options?: RasterizeTerminalOptions
): RasterizedTerminalImage {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: options?.pixelRatio ?? DEFAULT_PNG_PIXEL_RATIO },
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
  options?: PngRenderOptions
): RasterizedTerminalImage {
  const { pixelRatio, ...svgOptions } = options ?? {};
  const svg = renderTerminalToSvg(terminal, {
    ...svgOptions,
    embedFont: false,
  });
  return rasterizeTerminalSvg(svg, { pixelRatio });
}

import { rasterizeTerminalSvg } from '../lib/terminal-rasterizer.js';

export interface RasterizedFrame {
  png: Uint8Array;
  width: number;
  height: number;
}

export function rasterizeSvg(svg: string): RasterizedFrame {
  return rasterizeTerminalSvg(svg);
}

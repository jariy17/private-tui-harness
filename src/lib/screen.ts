/**
 * Screen reader utilities for extracting text content from an xterm Terminal buffer.
 *
 * This module provides functions that read the xterm buffer's internal line
 * data and return plain-text representations of the terminal screen. It
 * supports reading just the visible viewport, reading the full scrollback
 * history, retrieving cursor position and buffer type, and composing a
 * complete ScreenState snapshot.
 *
 * All functions accept a Terminal instance that must have been created with
 * `allowProposedApi: true` (required to access `terminal.buffer`).
 */
import type { ReadOptions, ScreenState } from './types.js';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

// ---------------------------------------------------------------------------
// Individual readers
// ---------------------------------------------------------------------------

/**
 * Read the visible viewport lines from the active buffer.
 *
 * The viewport starts at `baseY` (the first visible row when scrolled to the
 * bottom) and spans `terminal.rows` lines.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An array of strings, one per visible row, with trailing whitespace trimmed.
 */
export function readViewport(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const start = buffer.baseY;
  const lines: string[] = [];

  for (let i = start; i < start + terminal.rows; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }

  return lines;
}

/**
 * Read all lines in the active buffer, including scrollback history.
 *
 * Returns every line from index 0 through `baseY + terminal.rows - 1`,
 * covering the full scrollback plus the visible viewport.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An array of strings for every line in the buffer.
 */
export function readWithScrollback(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const totalLines = buffer.baseY + terminal.rows;
  const lines: string[] = [];

  for (let i = 0; i < totalLines; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }

  return lines;
}

/**
 * Get the current cursor position in the active buffer.
 *
 * The coordinates are 0-indexed and relative to the viewport (not the
 * scrollback). `cursorY` ranges from 0 to `terminal.rows - 1`.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An object with `x` and `y` properties.
 */
export function getCursor(terminal: Terminal): { x: number; y: number } {
  const buffer = terminal.buffer.active;
  return { x: buffer.cursorX, y: buffer.cursorY };
}

/**
 * Determine whether the terminal is using the normal or alternate screen buffer.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns `'normal'` or `'alternate'`.
 */
export function getBufferType(terminal: Terminal): 'normal' | 'alternate' {
  return terminal.buffer.active.type;
}

// ---------------------------------------------------------------------------
// Rich cell reading (with color attributes)
// ---------------------------------------------------------------------------

/**
 * A single terminal cell with text and styling attributes.
 */
export interface RichCell {
  char: string;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
}

/**
 * A row of rich cells.
 */
export type RichLine = RichCell[];

/**
 * The standard xterm 256-color palette.
 * Indices 0-7: normal colors, 8-15: bright colors,
 * 16-231: 6x6x6 color cube, 232-255: grayscale ramp.
 */
const XTERM_COLORS: string[] = [
  // 0-7: standard
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  // 8-15: bright
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

// 16-231: 6x6x6 color cube
for (let r = 0; r < 6; r++) {
  for (let g = 0; g < 6; g++) {
    for (let b = 0; b < 6; b++) {
      const ri = r ? 55 + r * 40 : 0;
      const gi = g ? 55 + g * 40 : 0;
      const bi = b ? 55 + b * 40 : 0;
      XTERM_COLORS.push(`#${ri.toString(16).padStart(2, '0')}${gi.toString(16).padStart(2, '0')}${bi.toString(16).padStart(2, '0')}`);
    }
  }
}

// 232-255: grayscale ramp
for (let i = 0; i < 24; i++) {
  const v = 8 + i * 10;
  XTERM_COLORS.push(`#${v.toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}`);
}

/**
 * Convert an xterm color value to a CSS hex string.
 * Returns null for default (unset) colors.
 */
function colorToHex(color: number, isRgb: boolean, r: number, g: number, b: number): string | null {
  if (isRgb) {
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  // color === 0 with isRgb false means default
  if (color === -1 || color === 0) {
    return null;
  }
  if (color >= 1 && color <= 256) {
    return XTERM_COLORS[color - 1] ?? null;
  }
  return null;
}

/**
 * Read the visible viewport with full color and style attributes per cell.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An array of RichLine, one per visible row.
 */
export function readViewportRich(terminal: Terminal): RichLine[] {
  const buffer = terminal.buffer.active;
  const start = buffer.baseY;
  const result: RichLine[] = [];

  for (let row = start; row < start + terminal.rows; row++) {
    const line = buffer.getLine(row);
    const richLine: RichLine = [];

    if (!line) {
      result.push(richLine);
      continue;
    }

    // Find the last non-empty cell to trim trailing whitespace
    let lastNonEmpty = -1;
    for (let col = line.length - 1; col >= 0; col--) {
      const cell = line.getCell(col);
      if (cell && cell.getChars() !== '' && cell.getChars() !== ' ') {
        lastNonEmpty = col;
        break;
      }
    }

    for (let col = 0; col <= lastNonEmpty; col++) {
      const cell = line.getCell(col);
      if (!cell) {
        richLine.push({ char: ' ', fg: null, bg: null, bold: false, italic: false, underline: false, dim: false });
        continue;
      }

      const chars = cell.getChars() || ' ';
      const fgColorMode = cell.isFgRGB();
      const bgColorMode = cell.isBgRGB();
      const fgColor = cell.getFgColor();
      const bgColor = cell.getBgColor();

      // For RGB mode, the color value encodes R/G/B in the integer
      const fgR = fgColorMode ? (fgColor >> 16) & 0xff : 0;
      const fgG = fgColorMode ? (fgColor >> 8) & 0xff : 0;
      const fgB = fgColorMode ? fgColor & 0xff : 0;
      const bgR = bgColorMode ? (bgColor >> 16) & 0xff : 0;
      const bgG = bgColorMode ? (bgColor >> 8) & 0xff : 0;
      const bgB = bgColorMode ? bgColor & 0xff : 0;

      // Check if it's a palette color (not default, not RGB)
      const fgIsPalette = !fgColorMode && cell.isFgPalette();
      const bgIsPalette = !bgColorMode && cell.isBgPalette();

      let fg: string | null = null;
      let bg: string | null = null;

      if (fgColorMode) {
        fg = colorToHex(fgColor, true, fgR, fgG, fgB);
      } else if (fgIsPalette) {
        fg = XTERM_COLORS[fgColor] ?? null;
      }

      if (bgColorMode) {
        bg = colorToHex(bgColor, true, bgR, bgG, bgB);
      } else if (bgIsPalette) {
        bg = XTERM_COLORS[bgColor] ?? null;
      }

      richLine.push({
        char: chars,
        fg,
        bg,
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        underline: cell.isUnderline() !== 0,
        dim: cell.isDim() !== 0,
      });
    }

    result.push(richLine);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format an array of lines with right-aligned, 1-indexed line numbers.
 *
 * Example output for a 3-line array:
 * ```
 *   1 | first line
 *   2 | second line
 *   3 | third line
 * ```
 *
 * @param lines - The lines to number.
 * @returns A single string with newline-separated numbered lines.
 */
export function formatNumbered(lines: string[]): string {
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
}

// ---------------------------------------------------------------------------
// Composite snapshot
// ---------------------------------------------------------------------------

/**
 * Build a complete ScreenState snapshot from the terminal.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @param options - Optional ReadOptions controlling scrollback inclusion and numbering.
 * @returns A ScreenState object containing lines, cursor, dimensions, and buffer type.
 */
export function buildScreenState(terminal: Terminal, options?: ReadOptions): ScreenState {
  let lines = options?.includeScrollback ? readWithScrollback(terminal) : readViewport(terminal);

  if (options?.numbered) {
    const width = String(lines.length).length;
    lines = lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`);
  }

  return {
    lines,
    cursor: getCursor(terminal),
    dimensions: { cols: terminal.cols, rows: terminal.rows },
    bufferType: getBufferType(terminal),
  };
}

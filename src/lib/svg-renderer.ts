import { BUNDLED_FONT_FAMILY, getEmbeddedTerminalFontCss } from './font-assets.js';
import {
  DARK_TERMINAL_PROFILE,
  DARK_THEME,
  LIGHT_TERMINAL_PROFILE,
  LIGHT_THEME,
} from './terminal-profile.js';
import type { SvgTheme, TerminalVisualProfile } from './terminal-profile.js';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;
type BufferCell = ReturnType<Terminal['buffer']['active']['getNullCell']>;

export { DARK_TERMINAL_PROFILE, DARK_THEME, LIGHT_TERMINAL_PROFILE, LIGHT_THEME };
export type { SvgTheme, TerminalVisualProfile };

export interface SvgRenderOptions {
  profile?: TerminalVisualProfile;
  theme?: SvgTheme;
  fontSize?: number;
  fontFamily?: string;
  cellWidth?: number;
  lineHeight?: number;
  textBaseline?: number;
  embedFont?: boolean;
  showCursor?: boolean;
  showWindowChrome?: boolean;
  title?: string;
  padding?: number;
  borderRadius?: number;
  /** Optional short label drawn top-right (e.g. the key that produced this frame). */
  keyLabel?: string;
}

interface CellStyle {
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  overline: boolean;
  invisible: boolean;
}

interface Span {
  text: string;
  style: CellStyle;
  startCol: number;
  colWidth: number;
  fitToCells: boolean;
}

interface ResolvedRenderOptions {
  profile: TerminalVisualProfile;
  theme: SvgTheme;
  fontSize: number;
  fontFamily: string;
  charWidth: number;
  lineHeight: number;
  textBaseline: number;
  embedFont: boolean;
  showCursor: boolean;
  showWindowChrome: boolean;
  title: string;
  padding: number;
  borderRadius: number;
  keyLabel: string;
}

export function renderTerminalToSvg(terminal: Terminal, options?: SvgRenderOptions): string {
  const resolved = resolveOptions(options);
  const {
    profile,
    theme,
    fontSize,
    fontFamily,
    charWidth,
    lineHeight,
    textBaseline,
    embedFont,
    showCursor,
    showWindowChrome,
    title,
    padding,
    borderRadius,
    keyLabel,
  } = resolved;
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const rows = terminal.rows;
  const startRow = buffer.baseY;
  const chromeHeight = showWindowChrome ? 30 : 0;
  const contentWidth = cols * charWidth;
  const contentHeight = rows * lineHeight;
  const totalWidth = contentWidth + padding * 2;
  const totalHeight = contentHeight + padding * 2 + chromeHeight;
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;
  const rowSpans: Span[][] = [];
  const reusableCell = buffer.getNullCell();

  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(startRow + row);
    const spans: Span[] = [];
    let currentSpan: Span | undefined;

    if (!line) {
      rowSpans.push(spans);
      continue;
    }

    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col, reusableCell);
      if (!cell) {
        continue;
      }

      const width = cell.getWidth();
      if (width === 0) {
        continue;
      }

      const isCursorCell = showCursor && row === cursorY && col === cursorX;
      const style = resolveCellStyle(cell, theme, profile, isCursorCell);
      const fitToCells = width !== 1;
      const chars = cell.getChars() || ' ';

      if (
        currentSpan &&
        currentSpan.fitToCells === fitToCells &&
        stylesMatch(currentSpan.style, style)
      ) {
        currentSpan.text += chars;
        currentSpan.colWidth += width;
      } else {
        if (currentSpan) {
          spans.push(currentSpan);
        }
        currentSpan = {
          text: chars,
          style,
          startCol: col,
          colWidth: width,
          fitToCells,
        };
      }
    }

    if (currentSpan) {
      spans.push(currentSpan);
    }
    rowSpans.push(spans);
  }

  const svg: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatMetric(totalWidth)}" height="${formatMetric(totalHeight)}" viewBox="0 0 ${formatMetric(totalWidth)} ${formatMetric(totalHeight)}">`,
    '<style>',
  ];

  if (embedFont && fontFamily.includes(BUNDLED_FONT_FAMILY)) {
    svg.push(getEmbeddedTerminalFontCss());
  }

  svg.push(
    `.terminal-bg { fill: ${theme.background}; }`,
    `.terminal-text { font-family: ${fontFamily}; font-size: ${fontSize}px; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }`,
    '.terminal-bold { font-weight: 700; }',
    '.terminal-italic { font-style: oblique; }',
    '</style>',
    `<rect class="terminal-bg" width="100%" height="100%" rx="${borderRadius}"/>`
  );

  if (showWindowChrome) {
    svg.push(
      `<circle cx="${padding + 10}" cy="15" r="6" fill="#ff5f56"/>`,
      `<circle cx="${padding + 28}" cy="15" r="6" fill="#ffbd2e"/>`,
      `<circle cx="${padding + 46}" cy="15" r="6" fill="#27c93f"/>`
    );
    if (title) {
      svg.push(
        `<text x="50%" y="19" text-anchor="middle" class="terminal-text" fill="${theme.foreground}" font-size="${fontSize - 1}px">${escapeXml(title)}</text>`
      );
    }
    svg.push(
      `<line x1="0" y1="${chromeHeight}" x2="${formatMetric(totalWidth)}" y2="${chromeHeight}" stroke="${theme.foreground}" stroke-opacity="0.15"/>`
    );
  }

  svg.push(`<g transform="translate(${padding}, ${chromeHeight + padding})">`);

  for (let row = 0; row < rowSpans.length; row++) {
    const y = row * lineHeight;
    const spans = rowSpans[row]!;

    for (const span of spans) {
      if (span.style.bg !== theme.background) {
        svg.push(
          `<rect x="${formatMetric(span.startCol * charWidth)}" y="${formatMetric(y)}" width="${formatMetric(span.colWidth * charWidth)}" height="${formatMetric(lineHeight)}" fill="${span.style.bg}"/>`
        );
      }
    }

    for (const span of spans) {
      if (span.style.invisible || span.text.trim().length === 0) {
        continue;
      }

      const classes = ['terminal-text'];
      if (span.style.bold) {
        classes.push('terminal-bold');
      }
      if (span.style.italic) {
        classes.push('terminal-italic');
      }

      const attributes = [
        `x="${formatMetric(span.startCol * charWidth)}"`,
        `y="${formatMetric(y + textBaseline)}"`,
        'xml:space="preserve"',
        `class="${classes.join(' ')}"`,
        `fill="${span.style.fg}"`,
      ];
      const decorations = [
        span.style.underline ? 'underline' : undefined,
        span.style.strikethrough ? 'line-through' : undefined,
        span.style.overline ? 'overline' : undefined,
      ].filter((value): value is string => value !== undefined);

      if (decorations.length > 0) {
        attributes.push(`text-decoration="${decorations.join(' ')}"`);
      }
      if (span.fitToCells) {
        attributes.push(
          `textLength="${formatMetric(span.colWidth * charWidth)}"`,
          'lengthAdjust="spacingAndGlyphs"'
        );
      }

      svg.push(`<text ${attributes.join(' ')}>${escapeXml(span.text)}</text>`);
    }
  }

  svg.push('</g>');

  // Key tag: a rounded pill in the top-right corner showing the key that
  // produced this frame. Drawn last so it sits above the terminal content.
  if (keyLabel) {
    const tagFontSize = fontSize - 2;
    const tagCharW = tagFontSize * profile.cellWidthRatio;
    const tagText = ` ${keyLabel} `;
    const tagW = tagText.length * tagCharW + 8;
    const tagH = tagFontSize + 10;
    const tagX = totalWidth - tagW - padding;
    const tagY = showWindowChrome ? (chromeHeight - tagH) / 2 : padding;
    svg.push(
      `<rect x="${formatMetric(tagX)}" y="${formatMetric(tagY)}" width="${formatMetric(tagW)}" height="${formatMetric(tagH)}" rx="${formatMetric(tagH / 2)}" fill="${theme.foreground}" fill-opacity="0.14"/>`,
      `<text x="${formatMetric(tagX + tagW / 2)}" y="${formatMetric(tagY + tagH / 2 + tagFontSize * 0.35)}" text-anchor="middle" class="terminal-text terminal-bold" font-size="${tagFontSize}px" fill="${theme.foreground}">${escapeXml(tagText.trim())}</text>`
    );
  }

  svg.push('</svg>');
  return svg.join('\n');
}

function resolveOptions(options?: SvgRenderOptions): ResolvedRenderOptions {
  const profile = options?.profile ?? DARK_TERMINAL_PROFILE;
  const fontSize = options?.fontSize ?? profile.fontSize;

  return {
    profile,
    theme: options?.theme ?? profile.theme,
    fontSize,
    fontFamily: options?.fontFamily ?? profile.fontFamily,
    charWidth: options?.cellWidth ?? fontSize * profile.cellWidthRatio,
    lineHeight: options?.lineHeight ?? Math.ceil(fontSize * profile.lineHeightRatio),
    textBaseline: options?.textBaseline ?? fontSize * profile.baselineRatio,
    embedFont: options?.embedFont ?? true,
    showCursor: options?.showCursor ?? true,
    showWindowChrome: options?.showWindowChrome ?? profile.showWindowChrome,
    title: options?.title ?? '',
    padding: options?.padding ?? profile.padding,
    borderRadius: options?.borderRadius ?? profile.borderRadius,
    keyLabel: options?.keyLabel ?? '',
  };
}

function resolveCellStyle(
  cell: BufferCell,
  theme: SvgTheme,
  profile: TerminalVisualProfile,
  isCursorCell: boolean
): CellStyle {
  const bold = cell.isBold() !== 0;
  let fg = resolveColor(cell, 'fg', theme, bold && profile.drawBoldTextInBrightColors) ?? theme.foreground;
  let bg = resolveColor(cell, 'bg', theme, false) ?? theme.background;

  if (cell.isInverse() !== 0) {
    [fg, bg] = [bg, fg];
  }
  if (cell.isDim() !== 0) {
    fg = blendHex(fg, bg, 0.5);
  }
  if (isCursorCell) {
    fg = theme.background;
    bg = theme.cursor;
  }

  return {
    fg,
    bg,
    bold,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    overline: cell.isOverline() !== 0,
    invisible: cell.isInvisible() !== 0,
  };
}

function resolveColor(
  cell: BufferCell,
  type: 'fg' | 'bg',
  theme: SvgTheme,
  brightenBold: boolean
): string | null {
  const isDefault = type === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return null;
  }

  const isPalette = type === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const isRGB = type === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  let value = type === 'fg' ? cell.getFgColor() : cell.getBgColor();

  if (isPalette) {
    if (brightenBold && value < 8) {
      value += 8;
    }
    return value < 16 ? (theme.palette[value] ?? null) : ansi256ToHex(value);
  }
  if (isRGB) {
    return `#${((value >> 16) & 0xff).toString(16).padStart(2, '0')}${((value >> 8) & 0xff).toString(16).padStart(2, '0')}${(value & 0xff).toString(16).padStart(2, '0')}`;
  }
  return null;
}

function ansi256ToHex(index: number): string {
  if (index >= 232) {
    const gray = (index - 232) * 10 + 8;
    return `#${gray.toString(16).padStart(2, '0').repeat(3)}`;
  }

  const cubeIndex = index - 16;
  const values = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const r = values[Math.floor(cubeIndex / 36)]!;
  const g = values[Math.floor(cubeIndex / 6) % 6]!;
  const b = values[cubeIndex % 6]!;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function blendHex(foreground: string, background: string, opacity: number): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) {
    return foreground;
  }

  const channel = (front: number, back: number) => Math.round(front * opacity + back * (1 - opacity));
  return `#${[channel(fg.r, bg.r), channel(fg.g, bg.g), channel(fg.b, bg.b)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function parseHex(value: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) {
    return undefined;
  }
  const encoded = Number.parseInt(match[1]!, 16);
  return {
    r: (encoded >> 16) & 0xff,
    g: (encoded >> 8) & 0xff,
    b: encoded & 0xff,
  };
}

function stylesMatch(left: CellStyle, right: CellStyle): boolean {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strikethrough === right.strikethrough &&
    left.overline === right.overline &&
    left.invisible === right.invisible
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMetric(value: number): string {
  return String(Number(value.toFixed(3)));
}

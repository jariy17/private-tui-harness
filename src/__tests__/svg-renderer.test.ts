import {
  DARK_THEME,
  LIGHT_THEME,
  renderTerminalToSvg,
} from '../lib/svg-renderer.js';
import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

const { Terminal } = xtermHeadless;

describe('SVG renderer', () => {
  let terminal: InstanceType<typeof Terminal>;

  afterEach(() => {
    terminal?.dispose();
  });

  it('renders a terminal grid without stretching normal text', async () => {
    terminal = createTerminal();
    await write(terminal, 'Hello World');

    const svg = render({ showCursor: false });

    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(svg).toContain('Hello World');
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).not.toContain('lengthAdjust="spacing"');
    expect(svg).not.toContain('textLength=');
  });

  it('embeds the bundled font in self-contained SVG output', async () => {
    terminal = createTerminal();
    await write(terminal, 'font');

    const svg = renderTerminalToSvg(terminal, { showCursor: false });

    expect(svg).toContain("@font-face {font-family: 'DejaVu Sans Mono'");
    expect(svg).toContain('data:font/woff2;base64,');
    expect(svg).toContain('font-variant-ligatures: none');
  });

  it('includes or omits window chrome as requested', async () => {
    terminal = createTerminal();
    await write(terminal, 'test');

    expect(render({ showWindowChrome: true })).toContain('#ff5f56');
    expect(render({ showWindowChrome: false })).not.toContain('#ff5f56');
  });

  it('uses the requested theme', async () => {
    terminal = createTerminal();
    await write(terminal, 'test');

    expect(render({ theme: LIGHT_THEME })).toContain('.terminal-bg { fill: #ffffff; }');
    expect(render()).toContain(`.terminal-bg { fill: ${DARK_THEME.background}; }`);
    expect(render()).not.toMatch(/\.terminal-text\s*\{[^}]*fill:/);
  });

  it('uses the legible 16px terminal profile by default', async () => {
    terminal = createTerminal();
    await write(terminal, 'test');

    expect(render()).toContain('font-size: 16px');
  });

  it('renders the cursor as an opaque cell behind its text', async () => {
    terminal = createTerminal();
    await write(terminal, 'test');

    const svg = render({ showCursor: true });

    expect(svg).toContain(`fill="${DARK_THEME.cursor}"`);
    expect(svg).not.toContain('opacity="0.7"');
  });

  it('handles special XML characters and window titles', async () => {
    terminal = createTerminal();
    await write(terminal, '<div>&"test"</div>');

    const svg = render({ title: 'My <Terminal>' });

    expect(svg).toContain('&lt;div&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('My &lt;Terminal&gt;');
    expect(svg).toContain(`class="terminal-text" fill="${DARK_THEME.foreground}"`);
  });

  it('resolves inverse colors and text decorations', async () => {
    terminal = createTerminal();
    await write(terminal, '\x1b[31;44;7;4;9;53mX');

    const svg = render({ showCursor: false });

    expect(svg).toContain(`fill="${DARK_THEME.palette[1]}"`);
    expect(svg).toContain(`fill="${DARK_THEME.palette[4]}"`);
    expect(svg).toContain('text-decoration="underline line-through overline"');
  });

  it('keeps bold weight independent from ANSI color brightness', async () => {
    terminal = createTerminal();
    await write(terminal, '\x1b[1;31mX');

    const svg = render({ showCursor: false });

    expect(svg).toContain(`fill="${DARK_THEME.palette[1]}"`);
    expect(svg).not.toContain(`fill="${DARK_THEME.palette[9]}"`);
    expect(svg).toContain('terminal-bold');
  });

  it('does not paint invisible text', async () => {
    terminal = createTerminal();
    await write(terminal, 'visible \x1b[8msecret');

    const svg = render({ showCursor: false });

    expect(svg).toContain('visible');
    expect(svg).not.toContain('secret');
  });

  it('fits wide glyphs to their xterm cell width', async () => {
    terminal = createTerminal();
    await write(terminal, '界');

    const svg = render({ showCursor: false });

    expect(svg).toContain('textLength=');
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"');
  });

  it('reserves a fixed caption footer and escapes caption text', async () => {
    terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    await write(terminal, 'test');

    const withoutCaption = renderTerminalToSvg(terminal, {
      captionHeight: 56,
      embedFont: false,
    });
    const withCaption = renderTerminalToSvg(terminal, {
      captionHeight: 56,
      captionText: 'Review <the> deployment & continue.',
      embedFont: false,
    });

    expect(withCaption).toContain('Review &lt;the&gt; deployment &amp; continue.');
    expect(withCaption).toContain(`class="terminal-text" fill="${DARK_THEME.foreground}"`);
    expect(withCaption.match(/height="([^"]+)"/)?.[1]).toBe(
      withoutCaption.match(/height="([^"]+)"/)?.[1]
    );
  });

  function createTerminal() {
    return new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  }

  function render(options = {}) {
    return renderTerminalToSvg(terminal, {
      embedFont: false,
      ...options,
    });
  }
});

function write(terminal: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise(resolve => terminal.write(data, resolve));
}

export interface SvgTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  palette: string[];
}

export interface TerminalVisualProfile {
  name: string;
  theme: SvgTheme;
  fontFamily: string;
  fontSize: number;
  cellWidthRatio: number;
  lineHeightRatio: number;
  baselineRatio: number;
  padding: number;
  borderRadius: number;
  showWindowChrome: boolean;
  drawBoldTextInBrightColors: boolean;
}

export const DARK_THEME: SvgTheme = {
  name: 'dark',
  background: '#1e1e1e',
  foreground: '#e5e5e5',
  cursor: '#f2f2f2',
  palette: [
    '#1e1e1e',
    '#f14c4c',
    '#23d18b',
    '#f5f543',
    '#3b8eea',
    '#d670d6',
    '#29b8db',
    '#e5e5e5',
    '#808080',
    '#ff6b6b',
    '#5af78e',
    '#f3f99d',
    '#57c7ff',
    '#ff6ac1',
    '#9aedfe',
    '#ffffff',
  ],
};

export const LIGHT_THEME: SvgTheme = {
  name: 'light',
  background: '#ffffff',
  foreground: '#24292e',
  cursor: '#044289',
  palette: [
    '#24292e',
    '#cf222e',
    '#116329',
    '#4d2d00',
    '#0550ae',
    '#8250df',
    '#1b7c83',
    '#6e7781',
    '#57606a',
    '#a40e26',
    '#1a7f37',
    '#633c01',
    '#0969da',
    '#8250df',
    '#3192aa',
    '#8c959f',
  ],
};

const DEJAVU_MONO_WIDTH_RATIO = 1233 / 2048;

export const DARK_TERMINAL_PROFILE: TerminalVisualProfile = {
  name: 'dark',
  theme: DARK_THEME,
  fontFamily: '"DejaVu Sans Mono", monospace',
  fontSize: 16,
  cellWidthRatio: DEJAVU_MONO_WIDTH_RATIO,
  lineHeightRatio: 1.3,
  baselineRatio: 1,
  padding: 10,
  borderRadius: 8,
  showWindowChrome: true,
  drawBoldTextInBrightColors: false,
};

export const LIGHT_TERMINAL_PROFILE: TerminalVisualProfile = {
  ...DARK_TERMINAL_PROFILE,
  name: 'light',
  theme: LIGHT_THEME,
};

export const DEFAULT_TERMINAL_PROFILE = DARK_TERMINAL_PROFILE;

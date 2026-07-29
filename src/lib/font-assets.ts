import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export const BUNDLED_FONT_FAMILY = 'DejaVu Sans Mono';

interface BundledFontFace {
  fileStem: string;
  style: 'normal' | 'oblique';
  weight: 400 | 700;
}

const FONT_FACES: BundledFontFace[] = [
  { fileStem: 'DejaVuSansMono', style: 'normal', weight: 400 },
  { fileStem: 'DejaVuSansMono-Bold', style: 'normal', weight: 700 },
  { fileStem: 'DejaVuSansMono-Oblique', style: 'oblique', weight: 400 },
  { fileStem: 'DejaVuSansMono-BoldOblique', style: 'oblique', weight: 700 },
];

let embeddedFontCss: string | undefined;

function fontAssetPath(fileName: string): string {
  return fileURLToPath(new URL(`../../assets/fonts/${fileName}`, import.meta.url));
}

export function getBundledTerminalFontFiles(): string[] {
  return FONT_FACES.map(face => fontAssetPath(`${face.fileStem}.ttf`));
}

export function getEmbeddedTerminalFontCss(): string {
  if (embeddedFontCss) {
    return embeddedFontCss;
  }

  embeddedFontCss = FONT_FACES.map(face => {
    const data = readFileSync(fontAssetPath(`${face.fileStem}.woff2`)).toString('base64');
    return [
      '@font-face {',
      `font-family: '${BUNDLED_FONT_FAMILY}';`,
      `font-style: ${face.style};`,
      `font-weight: ${face.weight};`,
      `src: url(data:font/woff2;base64,${data}) format('woff2');`,
      '}',
    ].join('');
  }).join('\n');

  return embeddedFontCss;
}

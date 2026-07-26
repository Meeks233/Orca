// Bundle and minify the strict TypeScript frontend into browser-ready artifacts.
import { build, type BuildOptions } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (path: string): string => resolve(here, 'src', path);
const out = (path: string): string => resolve(here, '..', 'web', path);

// ---- site-logo tones ----
//
// A brand mark is drawn in the brand's colour, which the brand chose against
// ITS OWN background — so some marks are invisible on ours. X and TikTok are
// pure black and vanish on the dark theme; Snapchat yellow and Kick green vanish
// on the light one. Painting a white tile behind every logo "fixed" that by
// putting a white square on every row of an OLED-black UI, which is worse than
// the problem.
//
// So classify each bundled icon by the one colour it is drawn in, and let the
// stylesheet treat only the marks that actually need it (see .src-logo[data-tone]):
//
//   mono — achromatic and near-black (X, TikTok, Threads, …). These are the marks
//          whose own brand guidelines say "black on light, white on dark", so the
//          dark theme inverts them, exactly like the Orca brand mark.
//   deep — coloured, but too dark to read on the dark theme's black. Inverting
//          would destroy the hue, so these (and only these) keep a light chip.
//   neon — too light to read on the light theme's white; they get a dark chip
//          there, which is what those brands' own guidelines ask for.
//   ''   — reads fine on both; drawn bare, no plate, no filter.
//
// The floor is 2.5:1 — under WCAG's 3:1 for meaningful graphics, deliberately:
// the logo sits directly beside the site's name in text, so it identifies rather
// than informs, and a stricter bar would put a plate behind half the set.
const CONTRAST_FLOOR = 2.5;

function relativeLuminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function saturation(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// Marks that colour classification alone can't rescue: a SOLID coloured
// container (circle / rounded square) with the brand glyph KNOCKED OUT of it.
// The knockout is transparent, so on the dark card the cut-out shows the black
// page instead of the white the brand draws there — YouTube's play triangle, the
// Facebook "f", the Apple Music note all read as hollow. Colour says "reads fine
// on both themes" (the container does); it can't see the hole. These get the
// same light chip `deep` marks do, which fills the cut-out white on the dark
// theme. This is the one place the tone can't be derived from the pixels — a
// knockout is a shape fact, not a colour fact — so it's an explicit list.
const KNOCKOUT = new Set([
  'youtube', 'facebook', 'applemusic', 'applepodcasts',
  'mega', 'reddit', 'pinterest', 'xvideos',
]);

function siteIconTones(): Record<string, string> {
  const dir = resolve(here, '..', 'web', 'icons', 'sites');
  const tones: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.svg')) continue;
    const slug = file.replace(/\.svg$/, '');
    // A knockout mark's hole needs a light backing regardless of its own colour;
    // it overrides the colour-based verdict below.
    if (KNOCKOUT.has(slug)) {
      tones[slug] = 'deep';
      continue;
    }
    const svg = readFileSync(resolve(dir, file), 'utf8');
    // One colour per mark: these are single-colour brand glyphs, so the root
    // element's fill (or the globe's stroke) is the whole picture.
    const hex = /<svg[^>]*(?:fill|stroke)="#([0-9a-fA-F]{6})"/.exec(svg)?.[1];
    if (!hex) continue;
    const lum = relativeLuminance(hex);
    const tone =
      saturation(hex) < 0.3 && lum < 0.05 ? 'mono'
      : contrast(lum, 0) < CONTRAST_FLOOR ? 'deep'
      : contrast(lum, 1) < CONTRAST_FLOOR ? 'neon'
      : '';
    if (tone) tones[slug] = tone;
  }
  return tones;
}

const tones = siteIconTones();
console.log(
  `site logo tones: ${Object.entries(tones).map(([k, v]) => `${k}=${v}`).join(' ') || '(all bare)'}`,
);

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  legalComments: 'eof',
  logLevel: 'info',
} satisfies BuildOptions;

await Promise.all([
  build({
    ...common,
    entryPoints: [src('app.ts')],
    outfile: out('app.js'),
    define: { __SITE_ICON_TONES__: JSON.stringify(tones) },
  }),
  build({ ...common, entryPoints: [src('theme.ts')], outfile: out('theme.js') }),
  build({ ...common, entryPoints: [src('sw.ts')], outfile: out('sw.js') }),
  build({
    ...common,
    entryPoints: [src('style.css')],
    outfile: out('style.css'),
    loader: { '.css': 'css' },
  }),
]);

console.log('web/ assets built (app.js, theme.js, sw.js, style.css)');

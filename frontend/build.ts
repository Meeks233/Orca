// Bundle and minify the strict TypeScript frontend into browser-ready artifacts.
import { build, type BuildOptions } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (path: string): string => resolve(here, 'src', path);
const out = (path: string): string => resolve(here, '..', 'web', path);

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  legalComments: 'eof',
  logLevel: 'info',
} satisfies BuildOptions;

await Promise.all([
  build({ ...common, entryPoints: [src('app.ts')], outfile: out('app.js') }),
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

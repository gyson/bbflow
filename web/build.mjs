import { build } from 'esbuild';
import { Resvg } from '@resvg/resvg-js';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundledPackages, licenseNotices } from './licenses.mjs';

const output = new URL('../internal/webui/dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL('src/app.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  metafile: true,
  outfile: fileURLToPath(new URL('assets/app.js', output)),
});
await copyFile(new URL('index.html', import.meta.url), new URL('index.html', output));
const logo = await readFile(new URL('src/bbflow.svg', import.meta.url), 'utf8');
// macOS shows the status item image at 22 points. Render it at 2x with a 3-unit margin,
// so each unit of the 16-unit pixel grid is 2 pixels and the mark is 16 points wide.
// Template coloring uses only the alpha channel, so the menu bar ignores the logo colors.
if (!logo.includes('viewBox="0 0 16 16"')) throw new Error('src/bbflow.svg must use a 16-unit grid');
const menuLogo = logo.replace('<svg ', '<svg width="44" height="44" ').replace('viewBox="0 0 16 16"', 'viewBox="-3 -3 22 22"');
await writeFile(new URL('assets/menubar.png', output),
  new Resvg(menuLogo, { font: { loadSystemFonts: false } }).render().asPng());
// iOS ignores SVG icons for a home screen web app and shows transparent pixels as black.
// Render a 180-pixel PNG with a 2-unit margin, so each unit of the pixel grid is 9 pixels.
// A mid-gray tile stays visible on light and dark wallpapers. The bright dark-appearance
// band colors apply without their media query, because the icon has one fixed appearance.
const darkRules = logo.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*)\}\s*<\/style>/)?.[1];
if (!darkRules) throw new Error('src/bbflow.svg must define its dark colors in one media query');
const touchLogo = logo
  .replace(/<style>[\s\S]*<\/style>/, `<style>${darkRules}</style>`)
  .replace(/<svg [^>]*>/, (tag) => `${tag.replace('<svg ', '<svg width="180" height="180" ').replace('viewBox="0 0 16 16"', 'viewBox="-2 -2 20 20"')}
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4d55"/><stop offset="1" stop-color="#33353b"/></linearGradient>
  <rect x="-2" y="-2" width="20" height="20" fill="url(#tile)"/>`);
await writeFile(new URL('assets/apple-touch-icon.png', output),
  new Resvg(touchLogo, { font: { loadSystemFonts: false } }).render().asPng());
// The logo selects its own light or dark colors.
await writeFile(new URL('assets/favicon.svg', output), logo.replace('<svg ', '<svg width="32" height="32" '));
await writeFile(new URL('assets/licenses.txt', output), await licenseNotices(bundledPackages(result.metafile)));

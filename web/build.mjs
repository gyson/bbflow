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
  loader: { '.svg': 'file' },
  assetNames: '[name]',
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
// The logo selects its own light or dark colors.
await writeFile(new URL('assets/favicon.svg', output), logo.replace('<svg ', '<svg width="32" height="32" '));
await writeFile(new URL('assets/licenses.txt', output), await licenseNotices(bundledPackages(result.metafile)));

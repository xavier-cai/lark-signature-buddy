import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_ROOT = join(ROOT, 'apps', 'web', 'src');

const [template, css, bundle] = await Promise.all([
  readFile(join(WEB_ROOT, 'index.html'), 'utf8'),
  readFile(join(WEB_ROOT, 'styles.css'), 'utf8'),
  build({
    entryPoints: [join(WEB_ROOT, 'app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    minify: true,
    target: ['chrome100'],
  }),
]);

const bundledScript = bundle.outputFiles[0].text;

function replaceRequired(source, marker, replacement) {
  if (!source.includes(marker)) {
    throw new Error(`Build template marker not found: ${marker}`);
  }
  return source.replace(marker, () => replacement);
}

const withMetadata = replaceRequired(
  template,
  '<meta name="color-scheme" content="light" />',
  `<meta name="color-scheme" content="light" />
    <meta name="use-iframe" content="true" />
    <meta name="html-box-height-mode" content="auto" />
    <meta name="description" content="飞书签名图片 Buddy：本地处理的网格切图工具" />`,
);
const withStyles = replaceRequired(
  withMetadata,
  '<link rel="stylesheet" href="./styles.css" />',
  `<style>${css}</style>`,
);
const output = replaceRequired(
  withStyles,
  '<script type="module" src="./app.js"></script>',
  `<script type="module">${bundledScript}</script>`,
);

await mkdir(join(ROOT, 'dist'), { recursive: true });
const outputPath = join(ROOT, 'dist', 'index.html');
await writeFile(outputPath, output, 'utf8');
console.log(outputPath);

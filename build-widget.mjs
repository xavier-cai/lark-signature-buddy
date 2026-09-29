import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = dirname(fileURLToPath(import.meta.url));

const [template, css, bundle] = await Promise.all([
  readFile(join(ROOT, 'public', 'index.html'), 'utf8'),
  readFile(join(ROOT, 'public', 'styles.css'), 'utf8'),
  build({
    entryPoints: [join(ROOT, 'public', 'app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    minify: true,
    target: ['chrome100'],
  }),
]);

const bundledScript = bundle.outputFiles[0].text;

const output = template
  .replace(
    '<meta name="color-scheme" content="light" />',
    `<meta name="color-scheme" content="light" />
    <meta name="use-iframe" content="true" />
    <meta name="html-box-height-mode" content="viewport" />
    <meta name="description" content="图片仔：离线网格切图并复制图片的文档工具" />`,
  )
  .replace(
    '<link rel="stylesheet" href="./styles.css" />',
    () => `<style>${css}</style>`,
  )
  .replace(
    '<script type="module" src="./app.js"></script>',
    () => `<script type="module">${bundledScript}</script>`,
  );

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'image-buddy-widget.html'), output, 'utf8');
console.log(join(ROOT, 'dist', 'image-buddy-widget.html'));

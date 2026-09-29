import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.IMAGE_BUDDY_API_URL;

if (!API_URL) {
  throw new Error('IMAGE_BUDDY_API_URL is required');
}

const [template, css, gridCore, js] = await Promise.all([
  readFile(join(ROOT, 'public', 'index.html'), 'utf8'),
  readFile(join(ROOT, 'public', 'styles.css'), 'utf8'),
  readFile(join(ROOT, 'public', 'grid-core.js'), 'utf8'),
  readFile(join(ROOT, 'public', 'app.js'), 'utf8'),
]);

const bundledScript = `${gridCore.replaceAll('export ', '')}\n${js.replace(
  "import { fitCrop, parseGrid, selectionAspect, tileRects } from './grid-core.js';\n\n",
  '',
)}`;

const output = template
  .replace(
    '<meta name="color-scheme" content="light" />',
    `<meta name="color-scheme" content="light" />
    <meta name="use-iframe" content="true" />
    <meta name="html-box-height-mode" content="viewport" />
    <meta name="description" content="图片仔：上传图片并获取飞书 Image Key 的本地工具" />
    <meta name="image-buddy-api" content="${API_URL.replaceAll('&', '&amp;')}" />`,
  )
  .replace('<link rel="stylesheet" href="./styles.css" />', `<style>${css}</style>`)
  .replace(
    '<script type="module" src="./app.js"></script>',
    `<script type="module">${bundledScript}</script>`,
  );

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'image-buddy-widget.html'), output, 'utf8');
console.log(join(ROOT, 'dist', 'image-buddy-widget.html'));

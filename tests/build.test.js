import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('build creates a self-contained static application', async () => {
  await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root });

  const output = await readFile(
    join(root, 'dist', 'index.html'),
    'utf8',
  );

  assert.doesNotMatch(
    output,
    /<script type="module" src="\.\/app\.js"><\/script>/,
  );
  assert.equal(output.match(/<script type="module">/g)?.length, 1);
  assert.equal(output.match(/<\/script>/g)?.length, 1);
  assert.equal(output.match(/<style>/g)?.length, 1);
  assert.doesNotMatch(output, /href="\.\/styles\.css"/);
  assert.match(
    output,
    /<meta name="html-box-height-mode" content="auto" \/>/,
  );
  assert.doesNotMatch(
    output,
    /<meta name="html-box-height-mode" content="viewport" \/>/,
  );
  assert.match(
    output,
    /grid-template-columns:\s*minmax\(0,\s*1\.55fr\)\s+minmax\(300px,\s*0\.75fr\)/,
  );
  assert.match(output, /@media\s*\(max-width:\s*720px\)/);
  assert.doesNotMatch(output, /@media\s*\(max-width:\s*860px\)/);
  assert.match(
    output,
    /min-height:\s*clamp\(350px,\s*43vw,\s*510px\)/,
  );
  assert.match(output, /@media\s*\(max-width:\s*900px\)/);
  assert.match(
    output,
    /\.section-heading\.compact\s*\{[^}]*flex-direction:\s*column/s,
  );
  assert.match(output, /id="frame-picker"/);
  assert.match(output, /frame-picker-track/);
  assert.match(output, /ImageDecoder/);
  assert.match(output, /选择裁剪参考帧/);
  assert.ok(
    output.indexOf('id="frame-section"') <
      output.indexOf('<aside class="control-panel">'),
    'frame picker should render inside the main canvas panel',
  );
  assert.match(output, /<details class="advanced-settings">/);
  assert.doesNotMatch(output, /<details class="advanced-settings" open>/);
  assert.match(output, /id="color-mapping"/);
  assert.match(
    output,
    /id="mapping-gamma"[^>]*min="0"[^>]*max="300"[^>]*step="10"[^>]*value="100"/,
  );
  assert.match(output, /id="mapping-gamma-output">1\.00/);
  assert.match(output, /id="grid-cols"[^>]*max="13"/);
  assert.match(output, /id="grid-rows"[^>]*max="5"/);
  assert.match(output, /id="preview-gap-ratio"[^>]*value="58"/);
  assert.match(
    output,
    /id="preview-scale"[^>]*min="25"[^>]*max="300"[^>]*step="25"[^>]*value="100"/,
  );
  assert.match(output, /id="preview-scale-output">100%/);
  assert.match(output, /id="precut-gap-ratio"[^>]*value="58"/);
  assert.ok(
    output.indexOf('id="precut-gap-ratio"') <
      output.indexOf('<details class="advanced-settings">'),
    'pre-crop gap should remain a normal setting',
  );
  assert.ok(
    output.indexOf('id="preview-gap-ratio"') >
      output.indexOf('<details class="advanced-settings">') &&
      output.indexOf('id="preview-gap-ratio"') < output.indexOf('</details>'),
    'preview gap should be inside advanced settings',
  );
  assert.doesNotMatch(output, /id="mode-options"|name="mode"/);
  assert.doesNotMatch(output, /实际渲染间隔 \/ 子图边长/);
  assert.match(output, /mode:"precut"/);
  assert.doesNotMatch(output, /preview-comparison/);
  assert.doesNotMatch(output, /id="transport-preview"/);
  assert.doesNotMatch(output, /二维码|QR 图片|GIF 中间图/);
  assert.match(output, /适配飞书签名单色遮罩/);
  assert.match(output, /id="preview-mask"/);
  assert.match(output, /data-platform="pc"[^>]*>PC</);
  assert.match(output, /data-platform="mobile"[^>]*>Mobile</);
  assert.match(output, /previewPlatform==="mobile"/);
  assert.match(output, /id="preview-actual-size"[^>]*checked/);
  assert.match(output, />实际大小</);
  assert.match(output, /\.output-preview\.actual-size/);
  assert.match(output, /preview-viewport/);
  assert.match(output, />遮罩</);
  assert.doesNotMatch(output, /最终组合效果|动图预览/);
  assert.match(output, /3370ff/i);
  assert.match(output, /id="config-text"/);
  assert.match(
    output,
    /id="generate-button"[^>]*disabled>\s*<span>生成配置<\/span>/,
  );
  assert.doesNotMatch(output, /id="generate-label"|选择图片后即可生成配置/);
  assert.doesNotMatch(output, /生成配置字符串/);
  assert.doesNotMatch(output, /拖动网格定位/);
  assert.doesNotMatch(output, /id="file-name"/);
  assert.doesNotMatch(output, /class="topbar"|class="brand"/);
  assert.match(
    output,
    /id="reset-grid"[^>]*>重置网格<\/button>\s*<button[^>]*id="upload-button"[^>]*>换一张</,
  );
  assert.doesNotMatch(output, /生成并下载 GIF 动图/);
  assert.match(output, /mappedFrameData/);
  assert.doesNotMatch(output, /src="\.\/app\.js"/);
});

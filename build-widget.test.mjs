import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));

test('build embeds bundle replacement tokens literally', async () => {
  await execFileAsync(process.execPath, ['build-widget.mjs'], { cwd: root });

  const output = await readFile(
    join(root, 'dist', 'image-buddy-widget.html'),
    'utf8',
  );

  assert.doesNotMatch(
    output,
    /<script type="module" src="\.\/app\.js"><\/script>/,
  );
  assert.equal(output.match(/<script type="module">/g)?.length, 1);
  assert.equal(output.match(/<\/script>/g)?.length, 1);
  assert.match(output, /id="frame-picker"/);
  assert.match(output, /id="animation-badge"/);
  assert.match(output, /选择裁剪参考帧/);
  assert.match(output, /id="color-mapping"/);
  assert.match(output, /preview-comparison/);
  assert.match(output, /mappedFrameData/);
  assert.match(output, /右键复制会丢失动画帧/);
  assert.doesNotMatch(output, /src="\.\/app\.js"/);
});

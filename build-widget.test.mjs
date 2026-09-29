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
});

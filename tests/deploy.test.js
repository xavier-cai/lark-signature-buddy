import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('systemd installer renders a portable unit from the current clone', async () => {
  const larkCliPath = await realpath('/bin/true');
  const { stdout } = await execFileAsync(
    'bash',
    [
      'deploy/systemd/install.sh',
      '--print',
      '--service-name',
      'example-buddy',
      '--profile',
      'example-profile',
      '--request-ttl-ms',
      '123456',
      '--node',
      process.execPath,
      '--lark-cli',
      '/bin/true',
    ],
    { cwd: root },
  );

  assert.match(stdout, new RegExp(`WorkingDirectory=${root}`));
  assert.match(
    stdout,
    new RegExp(`ExecStart="${process.execPath}" "${root}/apps/bot/src/main.js"`),
  );
  assert.match(
    stdout,
    /Environment="LARK_SIGNATURE_BUDDY_PROFILE=example-profile"/,
  );
  assert.match(
    stdout,
    /Environment="LARK_SIGNATURE_BUDDY_REQUEST_TTL_MS=123456"/,
  );
  assert.match(
    stdout,
    new RegExp(`Environment="LARK_SIGNATURE_BUDDY_LARK_CLI=${larkCliPath}"`),
  );
  assert.doesNotMatch(stdout, /PROFILE=image-buddy/);
});

test('checked-in deployment files contain no machine-specific defaults', async () => {
  const files = await Promise.all([
    readFile(join(root, 'deploy/systemd/lark-signature-buddy.service.in'), 'utf8'),
    readFile(join(root, 'deploy/systemd/install.sh'), 'utf8'),
    readFile(join(root, 'README.md'), 'utf8'),
  ]);
  const content = files.join('\n');

  assert.doesNotMatch(
    content,
    /\/home\/|\/data00\/|workspace\/opensource|\.ai-devbox|\.npm-global/,
  );
  assert.doesNotMatch(content, /LARK_SIGNATURE_BUDDY_PROFILE=image-buddy/);
});

test('bot uses the configured lark-cli executable for every subprocess', async () => {
  const source = await readFile(
    join(root, 'apps', 'bot', 'src', 'main.js'),
    'utf8',
  );
  assert.match(
    source,
    /process\.env\.LARK_SIGNATURE_BUDDY_LARK_CLI \|\| 'lark-cli'/,
  );
  assert.equal(source.match(/spawn\(\s*LARK_CLI\s*,/g)?.length, 2);
  assert.doesNotMatch(source, /spawn\(\s*'lark-cli'/);
});

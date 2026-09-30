import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const runner = join(root, 'scripts', 'run-gitleaks.sh');
const installedGitleaks = join(root, '.tools', 'bin', 'gitleaks');

async function git(repo, ...args) {
  return execFileAsync('git', [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgSign=false',
    ...args,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

async function fixtureRepo(t) {
  const repo = await mkdtemp(join(tmpdir(), 'lark-signature-buddy-gate-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'Public Example');
  await git(repo, 'config', 'user.email', 'public@example.com');
  await writeFile(join(repo, 'README.md'), 'safe fixture\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '--quiet', '-m', 'initial fixture');
  return repo;
}

test('pinned gitleaks rejects a staged private key without echoing it', async (t) => {
  const repo = await fixtureRepo(t);
  const injectedConfig = join(repo, 'empty-rules.toml');
  await writeFile(
    injectedConfig,
    '[[rules]]\nid = "never-match"\ndescription = "never match"\nregex = "a^"\n',
  );
  const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const endMarker = ['-----END ', 'PRIVATE KEY-----'].join('');
  const payload = 'VGhpcyBpcyBhIHByaXZhdGUga2V5IHRlc3QgZml4dHVyZS4=';
  const privateKey = `${marker}\n${payload}\n${endMarker}\n`;
  await writeFile(join(repo, 'credential.pem'), privateKey);
  await git(repo, 'add', 'credential.pem');

  await assert.rejects(
    execFileAsync(
      runner,
      ['staged'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITLEAKS_BIN: installedGitleaks,
          GITLEAKS_CONFIG: injectedConfig,
          GITLEAKS_CONFIG_TOML:
            '[[rules]]\nid = "also-never-match"\ndescription = "never match"\nregex = "b^"\n',
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(`${error.stdout}\n${error.stderr}`, /leaks found: 1/i);
      assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, new RegExp(payload));
      return true;
    },
  );
});

test('security gate rejects an unpinned gitleaks version', async (t) => {
  const fakeDirectory = await mkdtemp(join(tmpdir(), 'lark-signature-buddy-fake-gitleaks-'));
  t.after(() => rm(fakeDirectory, { recursive: true, force: true }));
  const fake = join(fakeDirectory, 'gitleaks');
  await writeFile(fake, '#!/usr/bin/env bash\necho 0.0.0\n');
  await chmod(fake, 0o755);

  await assert.rejects(
    execFileAsync(
      runner,
      ['tracked'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITLEAKS_BIN: fake,
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /gitleaks v8\.30\.1 is required/);
      return true;
    },
  );
});

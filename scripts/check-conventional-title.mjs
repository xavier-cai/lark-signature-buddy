#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONVENTIONAL_TYPES = Object.freeze([
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'security',
  'style',
  'test',
]);

const typePattern = CONVENTIONAL_TYPES.join('|');
const titlePattern = new RegExp(
  `^(?:${typePattern})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S.*$`,
);

export function isConventionalTitle(title) {
  return titlePattern.test(title);
}

export function validateTitles(entries) {
  return entries.filter(({ title }) => !isConventionalTitle(title));
}

function usage() {
  return [
    'Usage:',
    '  node scripts/check-conventional-title.mjs --title <title>',
    '  node scripts/check-conventional-title.mjs --message-file <path>',
    '  node scripts/check-conventional-title.mjs --range <revision-range>',
    '  node scripts/check-conventional-title.mjs --new-tip <revision>',
  ].join('\n');
}

function commitEntries(revisions) {
  if (revisions.length === 0) {
    return [];
  }
  const output = execFileSync(
    'git',
    ['show', '--quiet', '--format=%H%x00%s', ...revisions],
    { encoding: 'utf8' },
  );
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, title] = line.split('\0');
      return { label: sha.slice(0, 12), title };
    });
}

function revisionsForRange(range) {
  const output = execFileSync(
    'git',
    ['rev-list', '--reverse', range],
    { encoding: 'utf8' },
  );
  return output.trim().split('\n').filter(Boolean);
}

function revisionsForNewTip(tip) {
  const output = execFileSync(
    'git',
    ['rev-list', '--reverse', tip, '--not', '--remotes'],
    { encoding: 'utf8' },
  );
  return output.trim().split('\n').filter(Boolean);
}

function fail(invalid) {
  console.error('Conventional title check failed:');
  for (const { label, title } of invalid) {
    console.error(`  ${label}: ${title}`);
  }
  console.error(
    `Expected: <type>[optional scope][optional !]: <description>\nAllowed types: ${CONVENTIONAL_TYPES.join(', ')}`,
  );
  process.exitCode = 1;
}

function main(args) {
  if (args.length !== 2) {
    throw new Error(usage());
  }

  const [mode, value] = args;
  let entries;
  if (mode === '--title') {
    entries = [{ label: 'title', title: value }];
  } else if (mode === '--message-file') {
    const title = readFileSync(value, 'utf8').split(/\r?\n/, 1)[0];
    entries = [{ label: 'commit', title }];
  } else if (mode === '--range') {
    entries = commitEntries(revisionsForRange(value));
  } else if (mode === '--new-tip') {
    entries = commitEntries(revisionsForNewTip(value));
  } else {
    throw new Error(usage());
  }

  const invalid = validateTitles(entries);
  if (invalid.length > 0) {
    fail(invalid);
  } else {
    console.log(`Conventional title check passed (${entries.length} checked)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

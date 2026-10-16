import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVENTIONAL_TYPES,
  isConventionalTitle,
  validateTitles,
} from '../scripts/check-conventional-title.mjs';

test('accepts the documented conventional title forms', () => {
  for (const type of CONVENTIONAL_TYPES) {
    assert.equal(isConventionalTitle(`${type}: describe the change`), true);
  }
  assert.equal(isConventionalTitle('fix(bot): preserve GIF frame delays'), true);
  assert.equal(isConventionalTitle('feat(core)!: change the recipe format'), true);
  assert.equal(isConventionalTitle('chore(deps-dev): update eslint'), true);
});

test('rejects missing, unsupported, or malformed title prefixes', () => {
  assert.equal(isConventionalTitle('Stream animated tile processing'), false);
  assert.equal(isConventionalTitle('feature: add streaming'), false);
  assert.equal(isConventionalTitle('feat add streaming'), false);
  assert.equal(isConventionalTitle('Feat: add streaming'), false);
  assert.equal(isConventionalTitle('feat(UI): add preview'), false);
  assert.equal(isConventionalTitle('feat:'), false);
  assert.equal(isConventionalTitle('feat:  add streaming'), false);
});

test('reports every invalid title with its label', () => {
  assert.deepEqual(
    validateTitles([
      { label: 'good', title: 'docs: explain naming' },
      { label: 'bad', title: 'Explain naming' },
      {
        label: 'merge',
        title: "Merge branch 'master' into feature",
        isMerge: true,
      },
    ]),
    [{ label: 'bad', title: 'Explain naming' }],
  );
});

test('does not exempt a merge-looking title on a regular commit', () => {
  assert.deepEqual(
    validateTitles([
      {
        label: 'regular',
        title: "Merge branch 'master' into feature",
        isMerge: false,
      },
    ]),
    [{
      label: 'regular',
      title: "Merge branch 'master' into feature",
      isMerge: false,
    }],
  );
});

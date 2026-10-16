import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMBED_HEIGHT_MESSAGE_TYPE,
  createEmbedHeightMessage,
  postEmbedHeight,
} from '../apps/web/src/embed-height.js';

test('normalizes measured embed heights into versioned messages', () => {
  assert.deepEqual(createEmbedHeightMessage(612.2), {
    type: EMBED_HEIGHT_MESSAGE_TYPE,
    height: 613,
  });
  assert.equal(createEmbedHeightMessage(0), null);
  assert.equal(createEmbedHeightMessage(Number.NaN), null);
});

test('reports changed heights to an embedding parent', () => {
  const messages = [];
  const currentWindow = {};
  const parentWindow = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
  };
  const root = {
    getBoundingClientRect() {
      return { height: 640.1 };
    },
  };

  const height = postEmbedHeight({
    root,
    currentWindow,
    parentWindow,
  });
  assert.equal(height, 641);
  assert.deepEqual(messages, [{
    message: {
      type: EMBED_HEIGHT_MESSAGE_TYPE,
      height: 641,
    },
    targetOrigin: '*',
  }]);

  assert.equal(
    postEmbedHeight({
      root,
      currentWindow,
      parentWindow,
      previousHeight: height,
    }),
    height,
  );
  assert.equal(messages.length, 1);
});

test('does not report when the page is not embedded', () => {
  const currentWindow = {
    postMessage() {
      assert.fail('standalone pages must not post height messages');
    },
  };
  const root = {
    getBoundingClientRect() {
      return { height: 500 };
    },
  };
  assert.equal(postEmbedHeight({
    root,
    currentWindow,
    parentWindow: currentWindow,
  }), 0);
});

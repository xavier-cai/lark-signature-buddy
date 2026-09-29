import assert from 'node:assert/strict';
import test from 'node:test';

import { detectImage } from './server.mjs';

test('detects supported image signatures', () => {
  assert.equal(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg');
  assert.equal(
    detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/png',
  );
  assert.equal(detectImage(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(detectImage(Buffer.from('RIFFxxxxWEBP', 'ascii')), 'image/webp');
});

test('rejects unknown binary content', () => {
  assert.equal(detectImage(Buffer.from('not an image')), null);
});

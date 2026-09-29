import assert from 'node:assert/strict';
import test from 'node:test';

import { detectImage } from './server.mjs';
import { eventBatchKey, extractImageKeys, formatReply } from './bot-core.mjs';
import {
  compositionUnits,
  fitCrop,
  parseGrid,
  selectionAspect,
  tileRects,
} from './public/grid-core.js';

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

test('parses supported grids', () => {
  assert.deepEqual(parseGrid('2x3'), { cols: 2, rows: 3 });
  assert.deepEqual(parseGrid('15x15'), { cols: 15, rows: 15 });
  assert.throws(() => parseGrid('0x4'), /Unsupported grid/);
  assert.throws(() => parseGrid('16x2'), /Unsupported grid/);
});

test('plain mode divides the selected area without gaps', () => {
  const crop = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
  const tiles = tileRects(crop, 2, 2, 'plain', 0.58);
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles[0], {
    row: 0,
    col: 0,
    x: 0.1,
    y: 0.2,
    width: 0.4,
    height: 0.3,
  });
  assert.equal(tiles[3].x + tiles[3].width, 0.9);
  assert.equal(tiles[3].y + tiles[3].height, 0.8);
});

test('precut mode reserves predictable gaps between square tiles', () => {
  const crop = { x: 0, y: 0, width: 1, height: 1 };
  const tiles = tileRects(crop, 2, 2, 'precut', 0.58);
  const tile = 1 / 2.58;
  const gap = tile * 0.58;
  assert.equal(tiles.length, 4);
  assert.ok(Math.abs(tiles[0].width - tile) < 1e-9);
  assert.ok(Math.abs(tiles[1].x - (tile + gap)) < 1e-9);
  assert.ok(Math.abs(tiles[2].y - (tile + gap)) < 1e-9);
});

test('supports the maximum 15x15 grid', () => {
  const crop = { x: 0, y: 0, width: 1, height: 1 };
  const tiles = tileRects(crop, 15, 15, 'precut', 0.58);
  assert.equal(tiles.length, 225);
  assert.deepEqual(
    tiles.map(({ row, col }) => [row, col]).at(-1),
    [14, 14],
  );
  const last = tiles.at(-1);
  assert.ok(Math.abs(last.x + last.width - 1) < 1e-9);
  assert.ok(Math.abs(last.y + last.height - 1) < 1e-9);
});

test('selection aspect includes reserved gap space', () => {
  assert.equal(selectionAspect(2, 3, 'plain', 0.58), 2 / 3);
  assert.equal(selectionAspect(2, 2, 'precut', 0.58), 1);
  assert.ok(selectionAspect(3, 2, 'precut', 0.58) > 1.5);
});

test('composition units always include actual renderer gaps', () => {
  assert.deepEqual(compositionUnits(2, 2, 0.58), {
    widthUnits: 2.58,
    heightUnits: 2.58,
  });
  assert.deepEqual(compositionUnits(15, 1, 0.25), {
    widthUnits: 18.5,
    heightUnits: 1,
  });
});

test('fit crop remains inside the source image', () => {
  const crop = fitCrop(1600, 900, 1, 0.9);
  assert.ok(crop.x >= 0 && crop.y >= 0);
  assert.ok(crop.x + crop.width <= 1);
  assert.ok(crop.y + crop.height <= 1);
  assert.ok(Math.abs((crop.width * 1600) / (crop.height * 900) - 1) < 1e-9);
});

test('extracts image keys from raw, rendered, and post content', () => {
  assert.deepEqual(extractImageKeys('{"image_key":"img_v3_single"}'), [
    'img_v3_single',
  ]);
  assert.deepEqual(
    extractImageKeys('![Image](img_v3_first)\n![Image](img_v3_second)'),
    ['img_v3_first', 'img_v3_second'],
  );
  assert.deepEqual(
    extractImageKeys({
      zh_cn: {
        content: [
          [{ tag: 'img', image_key: 'img_v3_first' }],
          [{ tag: 'img', image_key: 'img_v3_second' }],
        ],
      },
    }),
    ['img_v3_first', 'img_v3_second'],
  );
});

test('deduplicates repeated image keys', () => {
  assert.deepEqual(
    extractImageKeys('img_v3_same img_v3_same img_v3_other'),
    ['img_v3_same', 'img_v3_other'],
  );
});

test('groups image messages by chat, sender, and thread context', () => {
  assert.equal(
    eventBatchKey({
      chat_id: 'oc_chat',
      sender_id: 'ou_user',
      thread_id: 'omt_thread',
    }),
    'oc_chat:ou_user:omt_thread',
  );
  assert.notEqual(
    eventBatchKey({ chat_id: 'oc_chat', sender_id: 'ou_user' }),
    eventBatchKey({ chat_id: 'oc_chat', sender_id: 'ou_other' }),
  );
});

test('formats keys and complete magic links', () => {
  const reply = formatReply(['img_v3_one', 'img_v3_two']);
  assert.match(reply, /收到 2 张图片/);
  assert.match(reply, /1\. img_v3_one/);
  assert.match(reply, /https:\/\/magic\.solutionsuite\.cn\/r\?k=img_v3_one/);
  assert.match(reply, /2\. img_v3_two/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeRecipeFromImage } from './bot-image.mjs';
import {
  eventBatchKey,
  extractImageKeys,
  extractImageRecipe,
  formatRecipeReceipt,
  formatReply,
} from './bot-core.mjs';
import {
  createImageRecipe,
  decodeImageRecipe,
  encodeImageRecipe,
  extractImageRecipeTokens,
} from './public/image-recipe.js';
import {
  compositionUnits,
  fitCrop,
  parseGrid,
  selectionAspect,
  tileRects,
} from './public/grid-core.js';
import {
  isAnimatedImageBytes,
  validateStaticImageSize,
} from './public/image-format.js';
import {
  embedRecipeInPng,
  extractRecipeFromPng,
} from './public/png-recipe.js';

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

const recipe = createImageRecipe({
  sourceWidth: 1600,
  sourceHeight: 900,
  cols: 3,
  rows: 2,
  crop: { x: 0.1, y: 0.2, width: 0.75, height: 0.6 },
  mode: 'precut',
  gapRatio: 0.58,
  outputSize: 512,
});

test('round-trips the shared V1 image recipe', () => {
  const token = encodeImageRecipe(recipe);
  assert.match(token, /^IB1:[A-Za-z0-9_-]+$/);
  assert.ok(token.length <= 64);
  assert.deepEqual(decodeImageRecipe(token), recipe);
});

test('extracts a recipe from nested Lark message content', () => {
  const token = encodeImageRecipe(recipe);
  const content = JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'text', text: token }]],
    },
  });
  assert.deepEqual(extractImageRecipeTokens(content), [token]);
  assert.deepEqual(extractImageRecipe(content), recipe);
});

test('strictly rejects recipe version mismatches and extra fields', () => {
  const token = encodeImageRecipe(recipe);
  assert.throws(
    () => decodeImageRecipe(token.replace('IB1:', 'IB2:')),
    /仅支持 V1，收到 V2/,
  );
  const replacement = token.endsWith('A') ? 'B' : 'A';
  assert.throws(
    () => decodeImageRecipe(`${token.slice(0, -1)}${replacement}`),
    /CRC32 校验失败/,
  );
  assert.throws(
    () => encodeImageRecipe({ ...recipe, unexpected: true }),
    /payload 字段必须为/,
  );
});

test('formats a validated recipe receipt for one source image', () => {
  const reply = formatRecipeReceipt(['img_v3_source'], recipe);
  assert.match(reply, /切图参数读取成功/);
  assert.match(reply, /img_v3_source/);
  assert.match(reply, /网格：3 × 2（6 张）/);
  assert.match(reply, /模式：precut/);
  assert.match(
    formatRecipeReceipt(['img_one', 'img_two'], recipe),
    /期望 1 张原图，收到 2 张/,
  );
});

const tinyPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

test('embeds and extracts a recipe from PNG metadata without changing dimensions', async () => {
  const tinyRecipe = createImageRecipe({
    sourceWidth: 1,
    sourceHeight: 1,
    cols: 1,
    rows: 1,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    mode: 'plain',
    gapRatio: 0,
    outputSize: 512,
  });
  const token = encodeImageRecipe(tinyRecipe);
  const encoded = embedRecipeInPng(tinyPng, token);
  assert.equal(extractRecipeFromPng(encoded), token);
  assert.ok(encoded.length > tinyPng.length);
  const decoded = await decodeRecipeFromImage(encoded);
  assert.deepEqual(decoded.recipe, tinyRecipe);
  assert.deepEqual(decoded.image, {
    width: 1,
    height: 1,
    format: 'png',
  });
});

test('rejects PNGs without metadata and invalid image dimensions', async () => {
  await assert.rejects(() => decodeRecipeFromImage(tinyPng), /未找到 ImageBuddy/);
  assert.throws(() => validateStaticImageSize(8192, 8192), /32 MP/);
  assert.throws(() => validateStaticImageSize(9000, 10), /8192 px/);
});

test('detects GIF, APNG, and animated WebP signatures', () => {
  assert.equal(
    isAnimatedImageBytes(new TextEncoder().encode('GIF89a')),
    true,
  );
  const apng = new Uint8Array(32);
  apng.set([0x89, 0x50, 0x4e, 0x47], 0);
  apng.set([0, 0, 0, 0], 8);
  apng.set(new TextEncoder().encode('acTL'), 12);
  assert.equal(isAnimatedImageBytes(apng), true);
  const animatedWebp = new Uint8Array(20);
  animatedWebp.set(new TextEncoder().encode('RIFF'), 0);
  animatedWebp.set(new TextEncoder().encode('WEBP'), 8);
  animatedWebp.set(new TextEncoder().encode('ANIM'), 12);
  assert.equal(isAnimatedImageBytes(animatedWebp), true);
  assert.equal(
    isAnimatedImageBytes(new TextEncoder().encode('RIFF0000WEBPVP8 ')),
    false,
  );
});

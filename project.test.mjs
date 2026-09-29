import assert from 'node:assert/strict';
import test from 'node:test';

import QRCode from 'qrcode';
import sharp from 'sharp';

import { decodeRecipeFromImage } from './bot-image.mjs';
import {
  buildTileSpecs,
  generateAndUploadTiles,
  renderTile,
} from './bot-tiles.mjs';
import {
  eventBatchKey,
  extractImageKeys,
  formatGeneratedReply,
  formatRecipeReceipt,
} from './bot-core.mjs';
import {
  createImageRecipe,
  decodeImageRecipe,
  encodeImageRecipe,
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
  QR_LABEL_HEIGHT,
  QR_MARGIN,
  transportLayoutForSource,
} from './public/transport-core.js';

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

const layout = transportLayoutForSource(80, 100);
const recipe = createImageRecipe({
  sourceWidth: 80,
  sourceHeight: 100,
  cols: 3,
  rows: 2,
  crop: { x: 0.1, y: 0.2, width: 0.75, height: 0.6 },
  mode: 'precut',
  gapRatio: 0.58,
  outputSize: 512,
  contentRect: {
    x: layout.sourceX / layout.canvasWidth,
    y: layout.sourceY / layout.canvasHeight,
    width: layout.sourceWidth / layout.canvasWidth,
    height: layout.sourceHeight / layout.canvasHeight,
  },
});

test('round-trips the shared V1 image recipe', () => {
  const token = encodeImageRecipe(recipe);
  assert.match(token, /^IB1:[A-Za-z0-9_-]+$/);
  assert.ok(token.length <= 64);
  assert.deepEqual(decodeImageRecipe(token), recipe);
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

test('formats generated image keys and magic links in row-major order', () => {
  const keys = Array.from({ length: 6 }, (_, index) => `img_tile_${index + 1}`);
  const reply = formatGeneratedReply(keys, recipe);
  assert.match(reply, /切图完成：3 × 2，共 6 张/);
  assert.match(reply, /1\. img_tile_1/);
  assert.match(
    reply,
    /https:\/\/magic\.solutionsuite\.cn\/r\?k=img_tile_1/,
  );
  assert.match(reply, /6\. img_tile_6/);
  assert.throws(
    () => formatGeneratedReply(keys.slice(0, 5), recipe),
    /期望 6 张，实际 5 张/,
  );
});

test('pads a narrow image and decodes its QR recipe end to end', async () => {
  assert.deepEqual(layout, {
    canvasWidth: 384,
    canvasHeight: 436,
    sourceX: 152,
    sourceY: 0,
    sourceWidth: 80,
    sourceHeight: 100,
    footerHeight: 336,
    qrSize: 256,
  });

  const qr = await QRCode.toBuffer(encodeImageRecipe(recipe), {
    type: 'png',
    width: layout.qrSize,
    margin: 4,
    errorCorrectionLevel: 'H',
  });
  const source = await sharp({
    create: {
      width: layout.sourceWidth,
      height: layout.sourceHeight,
      channels: 4,
      background: '#4f70d8',
    },
  })
    .png()
    .toBuffer();
  const transport = await sharp({
    create: {
      width: layout.canvasWidth,
      height: layout.canvasHeight,
      channels: 4,
      background: '#ffffff',
    },
  })
    .composite([
      { input: source, left: layout.sourceX, top: layout.sourceY },
      {
        input: qr,
        left: Math.round((layout.canvasWidth - layout.qrSize) / 2),
        top: layout.sourceHeight + QR_MARGIN + QR_LABEL_HEIGHT,
      },
    ])
    .png()
    .toBuffer();
  const decoded = await decodeRecipeFromImage(transport);
  assert.deepEqual(decoded.recipe, recipe);
  assert.deepEqual(decoded.image, {
    width: 384,
    height: 436,
    format: 'png',
  });

  const specs = buildTileSpecs(decoded.recipe, decoded.image);
  assert.equal(specs.length, 6);
  assert.deepEqual(
    specs.map(({ row, col }) => [row, col]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
  );
  for (const spec of specs) {
    assert.ok(spec.left >= layout.sourceX);
    assert.ok(spec.top >= layout.sourceY);
    assert.ok(spec.left + spec.width <= layout.sourceX + layout.sourceWidth);
    assert.ok(spec.top + spec.height <= layout.sourceY + layout.sourceHeight);
  }
  const firstTile = await renderTile(transport, specs[0]);
  const firstMetadata = await sharp(firstTile).metadata();
  assert.equal(firstMetadata.width, 512);
  assert.equal(firstMetadata.height, 512);
});

test('uploads rendered tiles concurrently while preserving result order', async () => {
  const source = await sharp({
    create: {
      width: layout.canvasWidth,
      height: layout.canvasHeight,
      channels: 4,
      background: '#ffffff',
    },
  })
    .png()
    .toBuffer();
  const calls = [];
  const keys = await generateAndUploadTiles({
    input: source,
    recipe,
    transportImage: {
      width: layout.canvasWidth,
      height: layout.canvasHeight,
      format: 'png',
    },
    profile: 'test-profile',
    concurrency: 3,
    runLark: async (args) => {
      const fileArg = args[args.indexOf('--file') + 1];
      const match = /tile-(\d+)\.png$/.exec(fileArg);
      assert.ok(match);
      const number = Number(match[1]);
      calls.push(number);
      await new Promise((resolve) => setTimeout(resolve, (7 - number) * 2));
      return { data: { image_key: `img_generated_${number}` } };
    },
  });
  assert.deepEqual(
    keys,
    Array.from({ length: 6 }, (_, index) => `img_generated_${index + 1}`),
  );
  assert.equal(calls.length, 6);
});

test('rejects transport canvases beyond the V1 resource limits', () => {
  assert.throws(() => transportLayoutForSource(8192, 8192), /32 MP/);
  assert.throws(() => transportLayoutForSource(9000, 10), /8192 px/);
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

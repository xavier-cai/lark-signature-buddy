import assert from 'node:assert/strict';
import test from 'node:test';

import QRCode from 'qrcode';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

import { decodeRecipeFromImage } from './bot-image.mjs';
import {
  decodeImageBytes,
  encodeApngBytes,
  encodeApngFrames,
} from './public/animation-core.js';
import { mapToLuminanceAlpha } from './public/color-mapping.js';
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
  qrSizeForModules,
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

test('maps RGB luminance and original alpha to grayscale transparency', () => {
  const output = mapToLuminanceAlpha(
    new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 255,
      255, 0, 0, 128,
    ]),
  );
  assert.deepEqual(Array.from(output), [
    254, 254, 254, 1,
    0, 0, 0, 255,
    54, 54, 54, 100,
  ]);
});

test('color mapping supports a reusable output buffer', () => {
  const output = new Uint8ClampedArray(4);
  assert.equal(
    mapToLuminanceAlpha(new Uint8ClampedArray([0, 255, 0, 64]), output),
    output,
  );
  assert.deepEqual(Array.from(output), [182, 182, 182, 18]);
  assert.throws(
    () => mapToLuminanceAlpha(new Uint8ClampedArray([1, 2, 3])),
    /RGBA 像素数据无效/,
  );
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

const compactQrSize = qrSizeForModules(41);
const layout = transportLayoutForSource(80, 100, compactQrSize);
const recipe = createImageRecipe({
  sourceWidth: 80,
  sourceHeight: 100,
  sourceFrames: 1,
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

test('round-trips the shared V3 image recipe', () => {
  const token = encodeImageRecipe(recipe);
  assert.match(token, /^IB3:[A-Za-z0-9_-]+$/);
  assert.ok(token.length <= 64);
  assert.deepEqual(decodeImageRecipe(token), recipe);
  assert.equal(recipe.output.format, 'png');
  assert.equal(recipe.source.animated, false);
});

test('strictly rejects recipe version mismatches and extra fields', () => {
  const token = encodeImageRecipe(recipe);
  assert.throws(
    () => decodeImageRecipe(token.replace('IB3:', 'IB2:')),
    /仅支持 V3，收到 V2/,
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
  assert.throws(
    () =>
      encodeImageRecipe({
        ...recipe,
        source: { ...recipe.source, animated: true },
      }),
    /animated 与 source.frames 不一致/,
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
    canvasHeight: 149,
    sourceX: 152,
    sourceY: 0,
    sourceWidth: 80,
    sourceHeight: 100,
    footerHeight: 49,
    qrSize: 49,
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
        top: layout.sourceHeight,
      },
    ])
    .png()
    .toBuffer();
  const decoded = await decodeRecipeFromImage(transport);
  assert.deepEqual(decoded.recipe, recipe);
  assert.deepEqual(decoded.image, {
    width: 384,
    height: 149,
    pages: 1,
    delay: [100],
    loop: 0,
    format: 'png',
  });
  const transcoded = await sharp(transport).jpeg({ quality: 65 }).toBuffer();
  const decodedAfterJpeg = await decodeRecipeFromImage(transcoded);
  assert.deepEqual(decodedAfterJpeg.recipe, recipe);

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

test('preserves animation frames, delays, loop, and alpha in APNG tiles', async () => {
  const animatedLayout = transportLayoutForSource(80, 100, compactQrSize);
  const animatedRecipe = createImageRecipe({
    sourceWidth: 80,
    sourceHeight: 100,
    sourceFrames: 2,
    cols: 2,
    rows: 2,
    crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    mode: 'plain',
    gapRatio: 0.58,
    outputSize: 512,
    contentRect: {
      x: animatedLayout.sourceX / animatedLayout.canvasWidth,
      y: animatedLayout.sourceY / animatedLayout.canvasHeight,
      width: animatedLayout.sourceWidth / animatedLayout.canvasWidth,
      height: animatedLayout.sourceHeight / animatedLayout.canvasHeight,
    },
  });
  assert.equal(animatedRecipe.output.format, 'apng');
  assert.equal(animatedRecipe.source.animated, true);
  const qr = await QRCode.toBuffer(encodeImageRecipe(animatedRecipe), {
    type: 'png',
    width: animatedLayout.qrSize,
    margin: 4,
    errorCorrectionLevel: 'H',
  });
  const transportFrames = [];
  for (const [red, blue, alpha] of [[255, 0, 64], [0, 255, 192]]) {
    const source = Buffer.alloc(80 * 100 * 4);
    for (let index = 0; index < source.length; index += 4) {
      source[index] = red;
      source[index + 2] = blue;
      source[index + 3] = alpha;
    }
    const canvas = await sharp({
      create: {
        width: animatedLayout.canvasWidth,
        height: animatedLayout.canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: source,
          raw: { width: 80, height: 100, channels: 4 },
          left: animatedLayout.sourceX,
          top: animatedLayout.sourceY,
        },
        {
          input: qr,
          left: Math.round(
            (animatedLayout.canvasWidth - animatedLayout.qrSize) / 2,
          ),
          top: animatedLayout.sourceHeight,
        },
      ])
      .raw()
      .toBuffer();
    transportFrames.push(new Uint8ClampedArray(
      canvas.buffer,
      canvas.byteOffset,
      canvas.byteLength,
    ));
  }
  const transport = Buffer.from(encodeApngBytes({
    width: animatedLayout.canvasWidth,
    height: animatedLayout.canvasHeight,
    frames: [
      { data: transportFrames[0], delay: 100 },
      { data: transportFrames[1], delay: 200 },
    ],
    loop: 0,
  }));
  const decoded = await decodeRecipeFromImage(transport);
  assert.deepEqual(decoded.recipe, animatedRecipe);
  assert.equal(decoded.image.pages, 2);
  assert.deepEqual(decoded.image.delay, [100, 200]);
  assert.equal(decoded.image.loop, 0);

  const tile = await renderTile(
    transport,
    buildTileSpecs(decoded.recipe, decoded.image)[0],
    decoded.image,
  );
  const decodedTile = await decodeImageBytes(tile, 'image/apng');
  assert.equal(decodedTile.width, 512);
  assert.equal(decodedTile.height, 512);
  assert.equal(decodedTile.frames.length, 2);
  assert.deepEqual(decodedTile.frames.map((frame) => frame.delay), [100, 200]);
  assert.equal(decodedTile.loop, 0);
  assert.ok(decodedTile.frames[0].data.some((value, index) =>
    index % 4 === 3 && value > 0 && value < 255));
});

test('browser APNG codec preserves RGBA, frame count, delays, and loop', async () => {
  const width = 16;
  const height = 12;
  const red = new Uint8ClampedArray(width * height * 4);
  const blue = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < red.length; index += 4) {
    red[index] = 255;
    red[index + 3] = 255;
    blue[index + 2] = 255;
    blue[index + 3] = 255;
  }
  red[3] = 128;
  const blob = await encodeApngFrames({
    width,
    height,
    frames: [
      { data: red, delay: 80 },
      { data: blue, delay: 160 },
    ],
    loop: 0,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const decoded = await decodeImageBytes(bytes, 'image/apng');
  assert.equal(decoded.frames.length, 2);
  assert.deepEqual(
    decoded.frames.map((frame) => frame.delay),
    [80, 160],
  );
  assert.equal(decoded.loop, 0);
  assert.equal(decoded.frames[0].data[3], 128);
});

test('browser APNG decoder preserves all frames and delays', async () => {
  const bytes = await readFile('./test-fixtures/animated-apng.png');
  const decoded = await decodeImageBytes(bytes, 'image/apng');
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 12);
  assert.equal(decoded.frames.length, 2);
  assert.deepEqual(
    decoded.frames.map((frame) => frame.delay),
    [80, 160],
  );
  assert.equal(decoded.loop, 0);
});

test('browser APNG frames can be normalized into a multi-frame APNG', async () => {
  const bytes = await readFile('./test-fixtures/animated-apng.png');
  const decoded = await decodeImageBytes(bytes, 'image/apng');
  const blob = await encodeApngFrames(decoded);
  const apng = await decodeImageBytes(
    new Uint8Array(await blob.arrayBuffer()),
    'image/apng',
  );
  assert.equal(apng.frames.length, 2);
  assert.deepEqual(
    apng.frames.map((frame) => frame.delay),
    [80, 160],
  );
  assert.equal(apng.loop, 0);
});

test('rejects transport canvases beyond the V3 resource limits', () => {
  assert.throws(() => transportLayoutForSource(8192, 8192, 147), /32 MP/);
  assert.throws(() => transportLayoutForSource(9000, 10, 147), /8192 px/);
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

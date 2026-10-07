import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
} from 'node:path';

import {
  downloadMessageImage,
  inspectSourceImage,
  prepareDownloadStaging,
} from '../apps/bot/src/image.js';
import {
  decodeImageBytes,
  encodeApngFrames,
  encodeGifFrames,
  openImageFrames,
} from '@lark-signature-buddy/core/animation';
import {
  DEFAULT_COLOR_MAPPING_GAMMA,
  mapToLuminanceAlpha,
  preprocessLarkSignature,
  renderLarkMobile,
  renderLarkPc,
} from '@lark-signature-buddy/core/color-mapping';
import {
  generateAndUploadTiles,
  prepareUploadStaging,
  renderTile,
} from '../apps/bot/src/tiles.js';
import {
  buildTileSpecs,
  MAX_ANIMATED_TILE_RAW_BYTES,
  MAX_SIGNATURE_TILE_SIZE,
} from '@lark-signature-buddy/core/tiles';
import {
  eventBatchKey,
  extractImageKeys,
  extractRecipeTokens,
  formatGeneratedReply,
  formatRecipeReceipt,
} from '../apps/bot/src/messages.js';
import {
  FRAME_OPTION_STEP,
  visibleFrameRange,
} from '../apps/web/src/frame-window.js';
import {
  LARK_SIGNATURE_TILE_SIZE,
  previewLayout,
} from '../apps/web/src/preview-layout.js';
import {
  clampPreviewScale,
  isPreviewTransformReset,
  movePreview,
  zoomPreviewAtPoint,
} from '../apps/web/src/preview-transform.js';
import { mergeRequestState } from '../apps/bot/src/request-state.js';
import { SerialQueue } from '../apps/bot/src/serial-queue.js';
import { writeApngFile } from '../apps/bot/src/apng-stream.js';
import {
  createSignatureRecipe,
  decodeSignatureRecipe,
  encodeSignatureRecipe,
} from '@lark-signature-buddy/core/recipe';
import {
  compositionUnits,
  fitCrop,
  parseGrid,
  selectionAspect,
  tileRects,
} from '@lark-signature-buddy/core/grid';
import {
  detectImageKind,
  isAnimatedImageBytes,
  validateStaticImageSize,
} from '@lark-signature-buddy/core/image-format';
import { validateAnimationWork } from '@lark-signature-buddy/core/transport';

test('parses supported grids', () => {
  assert.deepEqual(parseGrid('2x3'), { cols: 2, rows: 3 });
  assert.deepEqual(parseGrid('13x5'), { cols: 13, rows: 5 });
  assert.throws(() => parseGrid('0x4'), /Unsupported grid/);
  assert.throws(() => parseGrid('14x2'), /Unsupported grid/);
  assert.throws(() => parseGrid('2x6'), /Unsupported grid/);
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

test('supports the maximum 13x5 grid', () => {
  const crop = { x: 0, y: 0, width: 1, height: 1 };
  const tiles = tileRects(crop, 13, 5, 'precut', 0.58);
  assert.equal(tiles.length, 65);
  assert.deepEqual(
    tiles.map(({ row, col }) => [row, col]).at(-1),
    [4, 12],
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
  assert.deepEqual(compositionUnits(13, 1, 0.25), {
    widthUnits: 16,
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

test('gamma brightens G RGB without changing mobile alpha', () => {
  const source = new Uint8ClampedArray([128, 128, 128, 200]);
  const baseline = preprocessLarkSignature(source, undefined, 1);
  const brightened = preprocessLarkSignature(source, undefined, 0.8);
  assert.ok(brightened[0] > baseline[0]);
  assert.equal(brightened[3], baseline[3]);
});

test('separates preprocessing G from PC and mobile rendering F', () => {
  const source = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 128,
  ]);
  const preprocessed = preprocessLarkSignature(
    source,
    undefined,
    DEFAULT_COLOR_MAPPING_GAMMA,
  );
  assert.deepEqual(Array.from(preprocessed), [
    254, 254, 254, 1,
    0, 0, 0, 128,
  ]);
  assert.deepEqual(
    Array.from(renderLarkPc(preprocessed)),
    [
      51, 112, 254, 1,
      0, 0, 0, 128,
    ],
  );
  assert.deepEqual(
    Array.from(renderLarkMobile(preprocessed)),
    [
      51, 112, 255, 1,
      51, 112, 255, 128,
    ],
  );
  assert.throws(
    () => renderLarkPc(source, [51, 112]),
    /遮罩颜色/,
  );
});

test('extracts image keys from raw, rendered, and post content', () => {
  const secondImageKey = ['img_v3_', 'second'].join('');
  assert.deepEqual(extractImageKeys('{"image_key":"img_v3_single"}'), [
    'img_v3_single',
  ]);
  assert.deepEqual(
    extractImageKeys(`![Image](img_v3_first)\n![Image](${secondImageKey})`),
    ['img_v3_first', secondImageKey],
  );
  assert.deepEqual(
    extractImageKeys({
      zh_cn: {
        content: [
          [{ tag: 'img', image_key: 'img_v3_first' }],
          [{ tag: 'img', image_key: secondImageKey }],
        ],
      },
    }),
    ['img_v3_first', secondImageKey],
  );
});

test('deduplicates repeated image keys', () => {
  assert.deepEqual(
    extractImageKeys('img_v3_same img_v3_same img_v3_other'),
    ['img_v3_same', 'img_v3_other'],
  );
});

test('extracts recipe tokens from plain and structured content', () => {
  const first = `LSB1:${'A'.repeat(54)}-`;
  const second = `LSB1:${'b'.repeat(54)}_`;
  assert.deepEqual(
    extractRecipeTokens(`配置：${first}\n${first}`),
    [first],
  );
  assert.deepEqual(
    extractRecipeTokens({ text: second }),
    [second],
  );
});

test('request state accepts image and recipe together or in either order', () => {
  const token = `LSB1:${'A'.repeat(55)}`;
  const imageFirst = mergeRequestState({}, {
    imageKeys: ['img_source'],
    messageId: 'om_image',
    now: 1,
  });
  assert.equal(imageFirst.status, 'waiting_recipe');
  const imageThenRecipe = mergeRequestState(imageFirst.state, {
    recipeTokens: [token],
    messageId: 'om_recipe',
    now: 2,
  });
  assert.equal(imageThenRecipe.status, 'ready');
  assert.equal(imageThenRecipe.request.image.messageId, 'om_image');
  assert.equal(imageThenRecipe.request.recipeToken, token);

  const recipeFirst = mergeRequestState({}, {
    recipeTokens: [token],
    messageId: 'om_recipe',
    now: 3,
  });
  assert.equal(recipeFirst.status, 'waiting_image');
  const recipeThenImage = mergeRequestState(recipeFirst.state, {
    imageKeys: ['img_source'],
    messageId: 'om_image',
    now: 4,
  });
  assert.equal(recipeThenImage.status, 'ready');

  const together = mergeRequestState({}, {
    imageKeys: ['img_source'],
    recipeTokens: [token],
    messageId: 'om_both',
    now: 5,
  });
  assert.equal(together.status, 'ready');
  assert.match(together.message, /正在处理/);
  assert.equal(
    mergeRequestState({}, { messageId: 'om_other' }).status,
    'invalid',
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

test('virtualizes long frame pickers with an initial 20-frame window', () => {
  assert.deepEqual(
    visibleFrameRange({
      scrollLeft: 0,
      viewportWidth: 500,
      frameCount: 1798,
    }),
    { start: 0, end: 20 },
  );
  assert.deepEqual(
    visibleFrameRange({
      scrollLeft: 900 * FRAME_OPTION_STEP,
      viewportWidth: 500,
      frameCount: 1798,
    }),
    { start: 894, end: 912 },
  );
  assert.deepEqual(
    visibleFrameRange({
      scrollLeft: 1797 * FRAME_OPTION_STEP,
      viewportWidth: 500,
      frameCount: 1798,
    }),
    { start: 1791, end: 1798 },
  );
});

test('actual-size preview matches the 28px Lark icon and 44px cycle', () => {
  assert.equal(LARK_SIGNATURE_TILE_SIZE, 28);
  assert.deepEqual(
    previewLayout({
      cols: 6,
      rows: 4,
      gapRatio: 0.58,
      availableWidth: 280,
      actualSize: true,
    }),
    {
      tileSize: 28,
      gap: 16,
      width: 248,
      height: 160,
    },
  );
  assert.equal(
    previewLayout({
      cols: 13,
      rows: 5,
      gapRatio: 0.58,
      availableWidth: 280,
      actualSize: true,
    }).width,
    556,
  );
});

test('fitted preview uses the available width', () => {
  assert.deepEqual(
    previewLayout({
      cols: 2,
      rows: 2,
      gapRatio: 0.5,
      availableWidth: 280,
      actualSize: false,
    }),
    {
      tileSize: 112,
      gap: 56,
      width: 280,
      height: 280,
    },
  );
});

test('preview interaction zooms around the pointer and supports reset state', () => {
  assert.equal(clampPreviewScale(0.1), 0.25);
  assert.equal(clampPreviewScale(4), 3);
  assert.deepEqual(
    zoomPreviewAtPoint(
      { scale: 1, x: 0, y: 0 },
      2,
      { x: 30, y: -10 },
    ),
    { scale: 2, x: -30, y: 10 },
  );
  assert.deepEqual(
    movePreview(
      { scale: 2, x: -30, y: 10 },
      { x: 8, y: -4 },
    ),
    { scale: 2, x: -22, y: 6 },
  );
  assert.equal(
    isPreviewTransformReset({ scale: 1, x: 0, y: 0 }),
    true,
  );
  assert.equal(
    isPreviewTransformReset({ scale: 1.1, x: 0, y: 0 }),
    false,
  );
});

test('opens animated images lazily when ImageDecoder is available', async () => {
  const originalDecoder = globalThis.ImageDecoder;
  const originalDocument = globalThis.document;
  const decodedIndexes = [];
  class FakeImageDecoder {
    static async isTypeSupported(type) {
      return type === 'image/gif';
    }

    constructor() {
      this.tracks = {
        ready: Promise.resolve(),
        selectedTrack: {
          frameCount: 1798,
          repetitionCount: 0,
        },
      };
    }

    async decode({ frameIndex }) {
      decodedIndexes.push(frameIndex);
      return {
        image: {
          displayWidth: 2,
          displayHeight: 2,
          duration: 100000,
          close() {},
        },
      };
    }

    close() {}
  }
  globalThis.ImageDecoder = FakeImageDecoder;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            getImageData() {
              return { data: new Uint8ClampedArray(16) };
            },
          };
        },
      };
    },
  };
  try {
    const file = {
      type: 'image/gif',
      arrayBuffer: async () =>
        new TextEncoder().encode('GIF89a').buffer,
    };
    const animation = await openImageFrames(file);
    assert.equal(animation.frameCount, 1798);
    assert.equal(animation.lazy, true);
    assert.deepEqual(decodedIndexes, [0]);
    await animation.getFrame(20);
    assert.deepEqual(decodedIndexes, [0, 20]);
    animation.close();
  } finally {
    globalThis.ImageDecoder = originalDecoder;
    globalThis.document = originalDocument;
  }
});

test('downloads through a safe relative staging path and cleans it', async () => {
  const expected = Buffer.from('downloaded image bytes');
  let output;
  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-test-workspace-'),
  );
  try {
    const stagingRoot = await prepareDownloadStaging(workingDirectory);
    const actual = await downloadMessageImage({
      messageId: 'om_test',
      imageKey: 'img_test',
      profile: 'test-profile',
      workingDirectory,
      runLark: async (args) => {
        output = args[args.indexOf('--output') + 1];
        assert.equal(isAbsolute(output), false);
        assert.equal(output.includes('..'), false);
        assert.match(
          output,
          /^\.lark-signature-buddy-downloads\/request-[^/]+\/source-image\.png$/,
        );
        const absoluteOutput = join(workingDirectory, output);
        await mkdir(dirname(absoluteOutput), { recursive: true });
        await writeFile(absoluteOutput, expected);
        return { data: { saved_path: output } };
      },
    });
    assert.deepEqual(actual, expected);
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test('cleans relative download staging after CLI failures', async () => {
  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-test-workspace-'),
  );
  try {
    const stagingRoot = await prepareDownloadStaging(workingDirectory);
    await assert.rejects(
      downloadMessageImage({
        messageId: 'om_failure',
        imageKey: 'img_failure',
        profile: 'test-profile',
        workingDirectory,
        runLark: async (args) => {
          const output = args[args.indexOf('--output') + 1];
          assert.equal(isAbsolute(output), false);
          throw new Error('download failed');
        },
      }),
      /download failed/,
    );
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test('serial queue preserves per-context order without blocking other contexts', async () => {
  const queue = new SerialQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run('same-context', async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = queue.run('same-context', async () => {
    order.push('second');
  });
  const independent = queue.run('other-context', async () => {
    order.push('other');
  });

  await independent;
  assert.deepEqual(order, ['first:start', 'other']);
  releaseFirst();
  await Promise.all([first, second]);
  await queue.drain();
  assert.deepEqual(order, ['first:start', 'other', 'first:end', 'second']);
});

const recipe = createSignatureRecipe({
  sourceWidth: 80,
  sourceHeight: 100,
  sourceFrames: 1,
  cols: 3,
  rows: 2,
  crop: { x: 0.1, y: 0.2, width: 0.75, height: 0.6 },
  mode: 'precut',
  gapRatio: 0.58,
  colorMapping: true,
  outputSize: 512,
  contentRect: { x: 0, y: 0, width: 1, height: 1 },
});

test('round-trips the shared LSB1 signature recipe', () => {
  const token = encodeSignatureRecipe(recipe);
  assert.match(token, /^LSB1:[A-Za-z0-9_-]+$/);
  assert.ok(token.length <= 64);
  assert.deepEqual(decodeSignatureRecipe(token), recipe);
  assert.equal(recipe.output.format, 'png');
  assert.equal(recipe.source.animated, false);
  assert.equal(recipe.colorMapping, true);
  assert.equal(recipe.colorMappingGamma, 1);
});

test('strictly rejects recipe version mismatches and extra fields', () => {
  const token = encodeSignatureRecipe(recipe);
  assert.throws(
    () => decodeSignatureRecipe(token.replace('LSB1:', 'IB4:')),
    /缺少完整协议标记/,
  );
  assert.throws(
    () => decodeSignatureRecipe(token.replace('LSB1:', 'LSB2:')),
    /仅支持 V1，收到 V2/,
  );
  const mutationIndex = 12;
  const replacement = token[mutationIndex] === 'A' ? 'B' : 'A';
  assert.throws(
    () =>
      decodeSignatureRecipe(
        `${token.slice(0, mutationIndex)}${replacement}${token.slice(mutationIndex + 1)}`,
      ),
    /CRC32 校验失败/,
  );
  assert.throws(
    () => encodeSignatureRecipe({ ...recipe, unexpected: true }),
    /payload 字段必须为/,
  );
  assert.throws(
    () =>
      encodeSignatureRecipe({
        ...recipe,
        source: { ...recipe.source, animated: true },
      }),
    /animated 与 source.frames 不一致/,
  );
});

test('decodes legacy LSB1 tokens with gamma 1.0', () => {
  const legacy =
    'LSB1:TFMBwQAAAQgAAACUBgQU1QAA13T-bhcKAAAAAP____8CAAEHBnujlNk';
  assert.equal(decodeSignatureRecipe(legacy).colorMappingGamma, 1);
});

test('round-trips quantized mapping gamma in unused LSB1 flag bits', () => {
  for (const gamma of [0, 0.8, 1, 3]) {
    const value = { ...recipe, colorMappingGamma: gamma };
    assert.equal(
      decodeSignatureRecipe(encodeSignatureRecipe(value)).colorMappingGamma,
      gamma,
    );
  }
  assert.throws(
    () => encodeSignatureRecipe({ ...recipe, colorMappingGamma: 0.85 }),
    /步长必须为 0.1/,
  );
});

test('shared tile planner enforces source bounds without a frame-tile cap', () => {
  assert.throws(
    () => buildTileSpecs(recipe, { width: 0, height: 149 }),
    /原图片尺寸无效/,
  );
  const specs = buildTileSpecs(
    {
      ...recipe,
      source: {
        ...recipe.source,
        animated: true,
        frames: 1798,
      },
      grid: { cols: 13, rows: 5 },
    },
    { width: 80, height: 100 },
  );
  assert.equal(specs.length, 65);
});

test('recipe supports animations beyond 120 frames', () => {
  assert.doesNotThrow(() => validateAnimationWork(16, 16, 121));
  const animated = createSignatureRecipe({
    sourceWidth: 16,
    sourceHeight: 16,
    sourceFrames: 121,
    cols: 1,
    rows: 1,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    mode: 'precut',
    gapRatio: 0.58,
    colorMapping: true,
    outputSize: 512,
    contentRect: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.equal(decodeSignatureRecipe(encodeSignatureRecipe(animated)).source.frames, 121);
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
  const links = Array.from(
    { length: 6 },
    (_, index) =>
      `https://magic.solutionsuite.cn/r?k=img_tile_${index + 1}${(index + 1) % 3 === 0 ? '&t2=A' : ''}`,
  );
  const previewLinks = [
    links.slice(0, 3).join(' '),
    links.slice(3, 6).join(' '),
  ].join('\n');
  const copyLinks = links.join(' ');
  assert.match(reply, /切图完成：3 × 2，共 6 张/);
  assert.equal(reply.includes(`${links[0]} ${links[1]}`), true);
  assert.equal(reply.includes(`${links[0]}${links[1]}`), false);
  assert.equal(
    copyLinks.split(' ').every((link) => link.startsWith('https://')),
    true,
  );
  assert.equal(reply.includes(`${links[2]}\n${links[3]}`), true);
  const previewSection = reply.split('预览：\n')[1].split('\n\n复制：')[0];
  const copySection = reply.split('```text\n')[1].split('\n```')[0];
  assert.equal(previewSection, previewLinks);
  assert.equal(copySection, copyLinks);
  assert.equal(previewSection.split('\n').length, 2);
  assert.equal(copySection.includes('\n'), false);
  assert.match(reply, /\n```$/);
  assert.doesNotMatch(reply, /k=img_tile_1&t2=A/);
  assert.doesNotMatch(reply, /k=img_tile_2&t2=A/);
  assert.match(reply, /k=img_tile_3&t2=A/);
  assert.doesNotMatch(reply, /k=img_tile_4&t2=A/);
  assert.doesNotMatch(reply, /k=img_tile_5&t2=A/);
  assert.match(reply, /k=img_tile_6&t2=A/);
  assert.equal(reply.match(/&t2=A/g)?.length, 4);
  assert.throws(
    () => formatGeneratedReply(keys.slice(0, 5), recipe),
    /期望 6 张，实际 5 张/,
  );
});

test('validates and slices an original image with a separate recipe', async () => {
  const source = await sharp({
    create: {
      width: 80,
      height: 100,
      channels: 4,
      background: '#4f70d8',
    },
  })
    .png()
    .toBuffer();
  const image = await inspectSourceImage(source, recipe);
  assert.deepEqual(image, {
    width: 80,
    height: 100,
    pages: 1,
    delay: [100],
    loop: 0,
    format: 'png',
  });
  const specs = buildTileSpecs(recipe, image);
  assert.equal(specs.length, 6);
  assert.equal(specs[0].outputWidth, specs[0].width);
  assert.equal(specs[0].outputHeight, specs[0].height);
  assert.notEqual(specs[0].outputWidth, recipe.output.width);
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
    assert.ok(spec.left >= 0);
    assert.ok(spec.top >= 0);
    assert.ok(spec.left + spec.width <= 80);
    assert.ok(spec.top + spec.height <= 100);
  }
  const firstTile = await renderTile(source, specs[0]);
  const firstMetadata = await sharp(firstTile).metadata();
  assert.equal(firstMetadata.width, specs[0].width);
  assert.equal(firstMetadata.height, specs[0].height);
  await assert.rejects(
    inspectSourceImage(
      await sharp(source).resize(81, 100).png().toBuffer(),
      recipe,
    ),
    /原图片尺寸不一致/,
  );
  await assert.rejects(
    inspectSourceImage(source, {
      ...recipe,
      transport: {
        contentRect: { x: 0.1, y: 0, width: 0.9, height: 1 },
      },
    }),
    /不是原图直传格式/,
  );
});

test('accepts a decodable source larger than the former byte limit', async () => {
  const source = await sharp({
    create: {
      width: 80,
      height: 100,
      channels: 4,
      background: '#4f70d8',
    },
  })
    .png()
    .toBuffer();
  const paddedSource = Buffer.concat([
    source,
    Buffer.alloc(20 * 1024 * 1024),
  ]);
  assert.ok(paddedSource.length > 20 * 1024 * 1024);
  const image = await inspectSourceImage(paddedSource, recipe);
  assert.equal(image.width, 80);
  assert.equal(image.height, 100);
});

test('downscales large signature tiles to the display-size ceiling', async () => {
  const largeRecipe = createSignatureRecipe({
    sourceWidth: 400,
    sourceHeight: 200,
    sourceFrames: 1,
    cols: 1,
    rows: 1,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    mode: 'plain',
    gapRatio: 0.58,
    colorMapping: false,
    outputSize: 512,
    contentRect: { x: 0, y: 0, width: 1, height: 1 },
  });
  const source = await sharp({
    create: {
      width: 400,
      height: 200,
      channels: 4,
      background: '#4f70d8',
    },
  })
    .png()
    .toBuffer();
  const [spec] = buildTileSpecs(largeRecipe, {
    width: 400,
    height: 200,
  });
  assert.equal(spec.outputWidth, MAX_SIGNATURE_TILE_SIZE);
  assert.equal(spec.outputHeight, 25);

  for (const colorMapping of [false, true]) {
    const tile = await renderTile(source, spec, {
      pages: 1,
      colorMapping,
      colorMappingGamma: 1,
    });
    const metadata = await sharp(tile).metadata();
    assert.equal(metadata.width, MAX_SIGNATURE_TILE_SIZE);
    assert.equal(metadata.height, 25);
    assert.ok(tile.length < 10 * 1024 * 1024);
  }
});

test('uploads rendered tiles concurrently while preserving result order', async () => {
  const source = await sharp({
    create: {
      width: 80,
      height: 100,
      channels: 4,
      background: '#ffffff',
    },
  })
    .png()
    .toBuffer();
  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-test-workspace-'),
  );
  try {
    const stagingRoot = await prepareUploadStaging(workingDirectory);
    const calls = [];
    const keys = await generateAndUploadTiles({
      input: source,
      recipe,
      sourceImage: {
        width: 80,
        height: 100,
        pages: 1,
        format: 'png',
      },
      profile: 'test-profile',
      concurrency: 3,
      workingDirectory,
      runLark: async (args) => {
        const fileArg = args[args.indexOf('--file') + 1];
        const uploadPath = fileArg.slice('image='.length);
        assert.equal(isAbsolute(uploadPath), false);
        assert.equal(uploadPath.includes('..'), false);
        assert.match(
          uploadPath,
          /^\.lark-signature-buddy-uploads\/request-[^/]+\/tile-(\d+)\.png$/,
        );
        const number = Number(/tile-(\d+)\.png$/.exec(uploadPath)[1]);
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
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test('preserves animation frames, delays, loop, and alpha in APNG tiles', async () => {
  const animatedRecipe = createSignatureRecipe({
    sourceWidth: 80,
    sourceHeight: 100,
    sourceFrames: 2,
    cols: 2,
    rows: 2,
    crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    mode: 'plain',
    gapRatio: 0.58,
    colorMapping: true,
    outputSize: 512,
    contentRect: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.equal(animatedRecipe.output.format, 'apng');
  assert.equal(animatedRecipe.source.animated, true);
  const sourceFrames = [];
  for (const [red, blue, alpha] of [[255, 0, 64], [0, 255, 192]]) {
    const source = Buffer.alloc(80 * 100 * 4);
    for (let index = 0; index < source.length; index += 4) {
      source[index] = red;
      source[index + 2] = blue;
      source[index + 3] = alpha;
    }
    sourceFrames.push(new Uint8ClampedArray(
      source.buffer,
      source.byteOffset,
      source.byteLength,
    ));
  }
  const sourceBlob = await encodeGifFrames({
    width: 80,
    height: 100,
    frames: [
      { data: sourceFrames[0], delay: 100 },
      { data: sourceFrames[1], delay: 200 },
    ],
    loop: 0,
  });
  const sourceImage = Buffer.from(await sourceBlob.arrayBuffer());
  const image = await inspectSourceImage(sourceImage, animatedRecipe);
  assert.equal(image.pages, 2);
  assert.deepEqual(image.delay, [100, 200]);
  assert.equal(image.loop, 0);

  const tile = await renderTile(
    sourceImage,
    buildTileSpecs(animatedRecipe, image)[0],
    {
      ...image,
      colorMapping: animatedRecipe.colorMapping,
    },
  );
  const tileSpec = buildTileSpecs(animatedRecipe, image)[0];
  const decodedTile = await decodeImageBytes(tile, 'image/apng');
  assert.equal(decodedTile.width, tileSpec.width);
  assert.equal(decodedTile.height, tileSpec.height);
  assert.equal(decodedTile.frames.length, 2);
  assert.deepEqual(decodedTile.frames.map((frame) => frame.delay), [100, 200]);
  assert.equal(decodedTile.loop, 0);
  assert.ok(decodedTile.frames[0].data.some((value, index) =>
    index % 4 === 3 && value > 0 && value < 255));
});

test('downscales animated signature tiles before APNG encoding', async () => {
  const animatedRecipe = createSignatureRecipe({
    sourceWidth: 160,
    sourceHeight: 80,
    sourceFrames: 2,
    cols: 1,
    rows: 1,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    mode: 'plain',
    gapRatio: 0.58,
    colorMapping: true,
    outputSize: 512,
    contentRect: { x: 0, y: 0, width: 1, height: 1 },
  });
  const frames = [64, 192].map((alpha) => {
    const data = new Uint8ClampedArray(160 * 80 * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 80;
      data[index + 1] = 120;
      data[index + 2] = 220;
      data[index + 3] = alpha;
    }
    return { data, delay: 100 };
  });
  const sourceBlob = await encodeGifFrames({
    width: 160,
    height: 80,
    frames,
    loop: 0,
  });
  const source = Buffer.from(await sourceBlob.arrayBuffer());
  const image = await inspectSourceImage(source, animatedRecipe);
  const [spec] = buildTileSpecs(animatedRecipe, image);
  const tile = await renderTile(source, spec, {
    ...image,
    colorMapping: true,
    colorMappingGamma: 1,
  });
  const decoded = await decodeImageBytes(tile, 'image/apng');
  assert.equal(decoded.width, MAX_SIGNATURE_TILE_SIZE);
  assert.equal(decoded.height, 25);
  assert.equal(decoded.frames.length, 2);
  assert.ok(tile.length < 10 * 1024 * 1024);
});

test('reduces long animations against the upload byte budget', () => {
  const longAnimationRecipe = createSignatureRecipe({
    sourceWidth: 100,
    sourceHeight: 100,
    sourceFrames: 10000,
    cols: 1,
    rows: 1,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    mode: 'plain',
    gapRatio: 0.58,
    colorMapping: false,
    outputSize: 512,
    contentRect: { x: 0, y: 0, width: 1, height: 1 },
  });
  const [spec] = buildTileSpecs(longAnimationRecipe, {
    width: 100,
    height: 100,
    pages: 10000,
  });
  assert.ok(spec.outputWidth < MAX_SIGNATURE_TILE_SIZE);
  assert.ok(spec.outputHeight < MAX_SIGNATURE_TILE_SIZE);
  assert.ok(
    spec.outputWidth * spec.outputHeight * 4 * 10000 <=
      MAX_ANIMATED_TILE_RAW_BYTES,
  );
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

test('streaming APNG writer preserves frames, delays, loop, and alpha', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-apng-test-'),
  );
  const path = join(directory, 'streamed.png');
  const width = 4;
  const height = 3;
  const frames = [
    {
      data: new Uint8ClampedArray(width * height * 4).fill(0),
      delay: 80,
    },
    {
      data: new Uint8ClampedArray(width * height * 4).fill(0),
      delay: 160,
    },
  ];
  for (let index = 0; index < frames[0].data.length; index += 4) {
    frames[0].data[index] = 255;
    frames[0].data[index + 3] = 128;
    frames[1].data[index + 2] = 255;
    frames[1].data[index + 3] = 255;
  }
  try {
    await writeApngFile({
      path,
      width,
      height,
      frameCount: frames.length,
      loop: 2,
      renderFrame: async (index) => frames[index],
    });
    const decoded = await decodeImageBytes(
      await readFile(path),
      'image/apng',
    );
    assert.equal(decoded.frames.length, 2);
    assert.deepEqual(
      decoded.frames.map((frame) => frame.delay),
      [80, 160],
    );
    assert.equal(decoded.loop, 2);
    assert.equal(decoded.frames[0].data[0], 255);
    assert.equal(decoded.frames[0].data[3], 128);
    assert.equal(decoded.frames[1].data[2], 255);
    assert.equal(decoded.frames[1].data[3], 255);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('streaming APNG writer packs mapped frames as grayscale alpha', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-apng-test-'),
  );
  const path = join(directory, 'grayscale-alpha.png');
  const width = 4;
  const height = 3;
  const frames = Array.from({ length: 3 }, (_, frameIndex) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      const gray = frameIndex * 30 + index / 4;
      data[index] = gray;
      data[index + 1] = gray;
      data[index + 2] = gray;
      data[index + 3] = 200 - frameIndex * 20;
    }
    return { data, delay: 100 + frameIndex * 20 };
  });
  try {
    await writeApngFile({
      path,
      width,
      height,
      frameCount: frames.length,
      loop: 0,
      grayscaleAlpha: true,
      renderFrame: async (index) => frames[index],
    });
    const decoded = await decodeImageBytes(
      await readFile(path),
      'image/apng',
    );
    assert.equal(decoded.frames.length, 3);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      assert.deepEqual(
        decoded.frames[frameIndex].data,
        frames[frameIndex].data,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('streaming APNG writer stores mapped masks as indexed alpha', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-apng-test-'),
  );
  const path = join(directory, 'indexed-alpha.png');
  const width = 4;
  const height = 3;
  const frames = Array.from({ length: 3 }, (_, frameIndex) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      const alpha = frameIndex * 30 + index / 4;
      data[index] = 255 - alpha;
      data[index + 1] = 255 - alpha;
      data[index + 2] = 255 - alpha;
      data[index + 3] = alpha;
    }
    return { data, delay: 100 + frameIndex * 20 };
  });
  try {
    await writeApngFile({
      path,
      width,
      height,
      frameCount: frames.length,
      loop: 0,
      indexedAlpha: true,
      renderFrame: async (index) => frames[index],
    });
    const encoded = await readFile(path);
    assert.equal(encoded.indexOf(Buffer.from('PLTE')), 37);
    const decoded = await decodeImageBytes(encoded, 'image/apng');
    assert.equal(decoded.frames.length, frames.length);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      for (let index = 0; index < frames[frameIndex].data.length; index += 4) {
        assert.equal(
          decoded.frames[frameIndex].data[index + 3],
          frames[frameIndex].data[index + 3],
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('indexed APNG masks can quantize alpha without changing frame timing', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-apng-test-'),
  );
  const path = join(directory, 'quantized-alpha.png');
  const frames = [
    { data: new Uint8ClampedArray([80, 80, 80, 80]), delay: 80 },
    { data: new Uint8ClampedArray([170, 170, 170, 170]), delay: 160 },
  ];
  try {
    await writeApngFile({
      path,
      width: 1,
      height: 1,
      frameCount: frames.length,
      indexedAlpha: true,
      alphaLevels: 8,
      renderFrame: async (index) => frames[index],
    });
    const decoded = await decodeImageBytes(await readFile(path), 'image/apng');
    assert.deepEqual(
      decoded.frames.map((frame) => frame.delay),
      [80, 160],
    );
    assert.deepEqual(
      decoded.frames.map((frame) => frame.data[3]),
      [73, 182],
    );
    await assert.rejects(
      writeApngFile({
        path,
        width: 1,
        height: 1,
        frameCount: 1,
        indexedAlpha: true,
        alphaLevels: 1,
        renderFrame: async () => frames[0],
      }),
      /alpha 色阶/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser APNG decoder preserves all frames and delays', async () => {
  const bytes = await readFile('./tests/fixtures/animated-apng.png');
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
  const bytes = await readFile('./tests/fixtures/animated-apng.png');
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

test('rejects source images beyond the resource limits', () => {
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

test('rejects malformed WebP chunk lengths without looping', () => {
  const malformed = new Uint8Array(20);
  malformed.set(new TextEncoder().encode('RIFF'), 0);
  malformed.set(new TextEncoder().encode('WEBP'), 8);
  malformed.set(new TextEncoder().encode('JUNK'), 12);
  malformed.set([0xf8, 0xff, 0xff, 0xff], 16);
  assert.deepEqual(detectImageKind(malformed), {
    format: 'webp',
    animated: false,
  });
});

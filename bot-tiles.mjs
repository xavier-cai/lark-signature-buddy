import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import {
  decodeImageBytes,
  encodeApngBytes,
} from './public/animation-core.js';
import { tileRects } from './public/grid-core.js';

const MAX_TILES = 225;
const DEFAULT_CONCURRENCY = 4;
const MAX_FRAME_TILE_WORK = 3600;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toPixelRect(rect, imageWidth, imageHeight) {
  const left = clamp(Math.round(rect.x * imageWidth), 0, imageWidth - 1);
  const top = clamp(Math.round(rect.y * imageHeight), 0, imageHeight - 1);
  const right = clamp(
    Math.round((rect.x + rect.width) * imageWidth),
    left + 1,
    imageWidth,
  );
  const bottom = clamp(
    Math.round((rect.y + rect.height) * imageHeight),
    top + 1,
    imageHeight,
  );
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

export function buildTileSpecs(recipe, transportImage) {
  const { width: transportWidth, height: transportHeight } = transportImage;
  if (
    !Number.isInteger(transportWidth) ||
    !Number.isInteger(transportHeight) ||
    transportWidth < 1 ||
    transportHeight < 1
  ) {
    throw new Error('传输图片尺寸无效');
  }

  const source = toPixelRect(
    recipe.transport.contentRect,
    transportWidth,
    transportHeight,
  );
  const actualAspect = source.width / source.height;
  const expectedAspect = recipe.source.width / recipe.source.height;
  if (Math.abs(actualAspect / expectedAspect - 1) > 0.02) {
    throw new Error(
      `原图区域宽高比异常：实际 ${source.width}×${source.height}，参数 ${recipe.source.width}×${recipe.source.height}`,
    );
  }

  const normalizedTiles = tileRects(
    recipe.crop,
    recipe.grid.cols,
    recipe.grid.rows,
    recipe.mode,
    recipe.gapRatio,
  );
  if (normalizedTiles.length > MAX_TILES) {
    throw new Error(`切片数超过 ${MAX_TILES} 张上限`);
  }
  if (normalizedTiles.length * recipe.source.frames > MAX_FRAME_TILE_WORK) {
    throw new Error(
      `动图处理量过大：${normalizedTiles.length} 张 × ${recipe.source.frames} 帧，超过 ${MAX_FRAME_TILE_WORK} 上限`,
    );
  }

  return normalizedTiles.map((tile, index) => {
    const relative = toPixelRect(tile, source.width, source.height);
    return {
      index,
      row: tile.row,
      col: tile.col,
      left: source.left + relative.left,
      top: source.top + relative.top,
      width: relative.width,
      height: relative.height,
      outputWidth: recipe.output.width,
      outputHeight: recipe.output.height,
    };
  });
}

export async function renderTile(input, spec, animation = {}) {
  if (animation.pages > 1) {
    if (animation.format !== 'apng') {
      throw new Error('V3 动图切片只支持 APNG');
    }
    const decoded = animation.frames
      ? animation
      : await decodeImageBytes(input, 'image/apng');
    const frames = await Promise.all(
      decoded.frames.map(async (frame) => {
        const data = await sharp(Buffer.from(frame.data), {
          raw: {
            width: decoded.width,
            height: decoded.height,
            channels: 4,
          },
          failOn: 'warning',
        })
          .extract({
            left: spec.left,
            top: spec.top,
            width: spec.width,
            height: spec.height,
          })
          .resize(spec.outputWidth, spec.outputHeight, {
            fit: 'fill',
            kernel: sharp.kernel.lanczos3,
          })
          .raw()
          .toBuffer();
        return {
          data: new Uint8ClampedArray(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ),
          delay: frame.delay,
        };
      }),
    );
    return Buffer.from(encodeApngBytes({
      width: spec.outputWidth,
      height: spec.outputHeight,
      frames,
      loop: decoded.loop,
    }));
  }

  const pipeline = sharp(input, {
    failOn: 'warning',
  })
    .extract({
      left: spec.left,
      top: spec.top,
      width: spec.width,
      height: spec.height,
    })
    .resize(spec.outputWidth, spec.outputHeight, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    });
  return pipeline.png().toBuffer();
}

function imageKeyFromResponse(response) {
  const key =
    response?.data?.image_key ??
    response?.image_key ??
    response?.data?.data?.image_key;
  if (typeof key !== 'string' || !key.startsWith('img_')) {
    throw new Error('飞书上传响应缺少 image_key');
  }
  return key;
}

export async function generateAndUploadTiles({
  input,
  recipe,
  transportImage,
  profile,
  runLark,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const specs = buildTileSpecs(recipe, transportImage);
  const renderAnimation = transportImage.pages > 1
    ? {
      ...transportImage,
      ...(await decodeImageBytes(input, 'image/apng')),
    }
    : transportImage;
  const directory = await mkdtemp('.image-buddy-tiles-');
  const imageKeys = new Array(specs.length);
  let cursor = 0;
  let failure = null;
  let uploadedCount = 0;

  async function worker() {
    while (!failure) {
      const current = cursor;
      cursor += 1;
      if (current >= specs.length) return;
      const spec = specs[current];
      const extension = transportImage.pages > 1 ? 'apng' : 'png';
      const path = join(
        directory,
        `tile-${String(current + 1).padStart(3, '0')}.${extension}`,
      );
      try {
        const buffer = await renderTile(input, spec, renderAnimation);
        if (buffer.length > 10 * 1024 * 1024) {
          throw new Error(
            `第 ${current + 1} 张 ${extension.toUpperCase()} 超过飞书 10 MB 上传上限`,
          );
        }
        await writeFile(path, buffer, { mode: 0o600 });
        const response = await runLark([
          'im',
          'images',
          'create',
          '--profile',
          profile,
          '--as',
          'bot',
          '--data',
          '{"image_type":"message"}',
          '--file',
          `image=${path}`,
          '--json',
        ]);
        imageKeys[current] = imageKeyFromResponse(response);
        uploadedCount += 1;
      } catch (error) {
        failure = error;
      } finally {
        await unlink(path).catch(() => {});
      }
    }
  }

  try {
    const workerCount = Math.max(
      1,
      Math.min(specs.length, Math.floor(concurrency) || DEFAULT_CONCURRENCY),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failure) {
      const wrapped = new Error(
        `切片上传失败（已上传 ${uploadedCount}/${specs.length} 张）：${failure.message}`,
      );
      wrapped.uploadedCount = uploadedCount;
      wrapped.totalCount = specs.length;
      throw wrapped;
    }
    return imageKeys;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

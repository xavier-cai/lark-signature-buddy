import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import {
  decodeImageBytes,
  encodeApngBytes,
} from '@lark-signature-buddy/core/animation';
import { mapToLuminanceAlpha } from '@lark-signature-buddy/core/color-mapping';
import { buildTileSpecs } from '@lark-signature-buddy/core/tiles';

const DEFAULT_CONCURRENCY = 4;
export { buildTileSpecs };

export async function renderTile(input, spec, animation = {}) {
  if (animation.pages > 1) {
    if (animation.format !== 'gif') {
      throw new Error('动图传输只支持 GIF');
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
        const rgba = new Uint8ClampedArray(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        return {
          data: animation.colorMapping
            ? mapToLuminanceAlpha(rgba)
            : rgba,
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
  if (animation.colorMapping) {
    const { data } = await pipeline
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return sharp(Buffer.from(mapToLuminanceAlpha(data)), {
      raw: {
        width: spec.outputWidth,
        height: spec.outputHeight,
        channels: 4,
      },
    }).png().toBuffer();
  }
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
      ...(await decodeImageBytes(input, 'image/gif')),
      colorMapping: recipe.colorMapping,
    }
    : {
      ...transportImage,
      colorMapping: recipe.colorMapping,
    };
  const directory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-tiles-'),
  );
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
      const extension = 'png';
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

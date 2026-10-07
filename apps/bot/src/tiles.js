import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';
import process from 'node:process';

import sharp from 'sharp';

import {
  decodeImageBytes,
  encodeApngBytes,
} from '@lark-signature-buddy/core/animation';
import { preprocessLarkSignature } from '@lark-signature-buddy/core/color-mapping';
import { buildTileSpecs } from '@lark-signature-buddy/core/tiles';
import { writeApngFile } from './apng-stream.js';

const DEFAULT_CONCURRENCY = 4;
const UPLOAD_STAGING_NAME = '.lark-signature-buddy-uploads';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export { buildTileSpecs };

function uploadStagingRoot(workingDirectory = process.cwd()) {
  return join(workingDirectory, UPLOAD_STAGING_NAME);
}

export async function prepareUploadStaging(
  workingDirectory = process.cwd(),
) {
  const root = uploadStagingRoot(workingDirectory);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function renderAnimationFrame(
  frame,
  decoded,
  spec,
  colorMapping,
  colorMappingGamma,
) {
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
    data: colorMapping
      ? preprocessLarkSignature(rgba, undefined, colorMappingGamma)
      : rgba,
    delay: frame.delay,
  };
}

export async function renderTile(input, spec, animation = {}) {
  if (animation.pages > 1) {
    const decoded = animation.frames
      ? animation
      : await decodeImageBytes(input, `image/${animation.format}`);
    const frames = [];
    for (const frame of decoded.frames) {
      frames.push(
        await renderAnimationFrame(
          frame,
          decoded,
          spec,
          animation.colorMapping,
          animation.colorMappingGamma,
        ),
      );
    }
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
    return sharp(Buffer.from(preprocessLarkSignature(
      data,
      undefined,
      animation.colorMappingGamma,
    )), {
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
  sourceImage,
  profile,
  runLark,
  concurrency = DEFAULT_CONCURRENCY,
  workingDirectory = process.cwd(),
}) {
  const specs = buildTileSpecs(recipe, sourceImage);
  const renderAnimation = sourceImage.pages > 1
    ? {
      ...sourceImage,
      ...(sourceImage.frames
        ? {}
        : await decodeImageBytes(input, `image/${sourceImage.format}`)),
      colorMapping: recipe.colorMapping,
      colorMappingGamma: recipe.colorMappingGamma,
    }
    : {
      ...sourceImage,
      colorMapping: recipe.colorMapping,
      colorMappingGamma: recipe.colorMappingGamma,
    };
  const stagingRoot = uploadStagingRoot(workingDirectory);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stagingRoot, 'request-'));
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
        if (renderAnimation.pages > 1) {
          await writeApngFile({
            path,
            width: spec.outputWidth,
            height: spec.outputHeight,
            frameCount: renderAnimation.frames.length,
            loop: renderAnimation.loop,
            indexedAlpha:
              renderAnimation.colorMapping &&
              renderAnimation.format === 'gif',
            grayscaleAlpha:
              renderAnimation.colorMapping &&
              renderAnimation.format !== 'gif',
            gamma: renderAnimation.colorMappingGamma,
            renderFrame: (index) =>
              renderAnimationFrame(
                renderAnimation.frames[index],
                renderAnimation,
                spec,
                renderAnimation.colorMapping,
                renderAnimation.colorMappingGamma,
              ),
          });
        } else {
          const buffer = await renderTile(input, spec, renderAnimation);
          await writeFile(path, buffer, { mode: 0o600 });
        }
        const { size } = await stat(path);
        if (size > MAX_UPLOAD_BYTES) {
          throw new Error(
            `第 ${current + 1} 张 ${extension.toUpperCase()} 为 ${(size / 1024 / 1024).toFixed(2)} MiB，超过飞书 10 MiB 上传上限`,
          );
        }
        const relativePath = relative(workingDirectory, path);
        if (
          isAbsolute(relativePath) ||
          relativePath === '..' ||
          relativePath.startsWith('../')
        ) {
          throw new Error('上传 staging 路径必须位于运行目录内');
        }
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
          `image=${relativePath}`,
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
    const requestedConcurrency = renderAnimation.pages > 1
      ? 1
      : Math.floor(concurrency) || DEFAULT_CONCURRENCY;
    const workerCount = Math.max(
      1,
      Math.min(specs.length, requestedConcurrency),
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

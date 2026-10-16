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

import { preprocessLarkSignature } from '@lark-signature-buddy/core/color-mapping';
import { buildTileSpecs } from '@lark-signature-buddy/core/tiles';
import { streamAnimationFrames } from './animation-source.js';
import { createApngWriter } from './apng-stream.js';

const DEFAULT_CONCURRENCY = 4;
const ANIMATION_FRAME_CONCURRENCY = 2;
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
  const data = await sharp(Buffer.from(
    frame.data.buffer,
    frame.data.byteOffset,
    frame.data.byteLength,
  ), {
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
    throw new Error('动图必须通过流式切片流程处理');
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

async function mapWithConcurrency(values, concurrency, mapper) {
  let cursor = 0;
  let failure = null;
  async function worker() {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await mapper(values[index], index);
      } catch (error) {
        failure = error;
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(values.length, concurrency)) },
    () => worker(),
  ));
  if (failure) throw failure;
}

async function renderAnimationTiles({
  input,
  sourceImage,
  specs,
  paths,
  colorMapping,
  colorMappingGamma,
}) {
  const writers = [];
  try {
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      writers.push(await createApngWriter({
        path: paths[index],
        width: spec.outputWidth,
        height: spec.outputHeight,
        frameCount: sourceImage.pages,
        loop: sourceImage.loop,
        indexedAlpha: colorMapping && sourceImage.format === 'gif',
        grayscaleAlpha: colorMapping && sourceImage.format !== 'gif',
        gamma: colorMappingGamma,
        maxBytes: MAX_UPLOAD_BYTES,
      }));
    }
    for await (const frame of streamAnimationFrames(input, sourceImage)) {
      await mapWithConcurrency(
        specs,
        ANIMATION_FRAME_CONCURRENCY,
        async (spec, index) => {
          const rendered = await renderAnimationFrame(
            frame,
            sourceImage,
            spec,
            colorMapping,
            colorMappingGamma,
          );
          await writers[index].appendFrame(rendered);
        },
      );
    }
    await Promise.all(writers.map((writer) => writer.finish()));
  } catch (error) {
    await Promise.all(writers.map((writer) => writer.abort()));
    throw error;
  }
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
  const renderOptions = {
    ...sourceImage,
    colorMapping: recipe.colorMapping,
    colorMappingGamma: recipe.colorMappingGamma,
  };
  const stagingRoot = uploadStagingRoot(workingDirectory);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stagingRoot, 'request-'));
  const paths = specs.map((_, index) => join(
    directory,
    `tile-${String(index + 1).padStart(3, '0')}.png`,
  ));
  const imageKeys = new Array(specs.length);
  let cursor = 0;
  let failure = null;
  let uploadedCount = 0;

  async function renderStaticTiles() {
    await mapWithConcurrency(
      specs,
      Math.floor(concurrency) || DEFAULT_CONCURRENCY,
      async (spec, index) => {
        const buffer = await renderTile(input, spec, renderOptions);
        await writeFile(paths[index], buffer, { mode: 0o600 });
      },
    );
  }

  async function worker() {
    while (!failure) {
      const current = cursor;
      cursor += 1;
      if (current >= specs.length) return;
      const extension = 'png';
      const path = paths[current];
      try {
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
    if (sourceImage.pages > 1) {
      await renderAnimationTiles({
        input,
        sourceImage,
        specs,
        paths,
        colorMapping: recipe.colorMapping,
        colorMappingGamma: recipe.colorMappingGamma,
      });
    } else {
      await renderStaticTiles();
    }
    const requestedConcurrency = Math.floor(concurrency) || DEFAULT_CONCURRENCY;
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

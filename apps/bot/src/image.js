import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';
import process from 'node:process';

import sharp from 'sharp';

import {
  detectImageKind,
  validateStaticImageSize,
} from '@lark-signature-buddy/core/image-format';
import { parseApng } from './apng-source.js';

const MAX_IMAGE_PIXELS = 80 * 1024 * 1024;
const DOWNLOAD_STAGING_NAME = '.lark-signature-buddy-downloads';

function downloadStagingRoot(workingDirectory = process.cwd()) {
  return join(workingDirectory, DOWNLOAD_STAGING_NAME);
}

export async function prepareDownloadStaging(
  workingDirectory = process.cwd(),
) {
  const root = downloadStagingRoot(workingDirectory);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function inspectAnimation(bytes, kind) {
  if (kind.format === 'apng') {
    const animation = parseApng(bytes);
    validateStaticImageSize(animation.width, animation.height);
    return {
      width: animation.width,
      height: animation.height,
      pages: animation.pages,
      delay: animation.delay,
      loop: animation.loop,
      format: kind.format,
    };
  }
  const metadata = await sharp(bytes, {
    animated: true,
    // Metadata inspection does not expand the animation. The per-frame
    // dimensions are validated below, while decoded frames are consumed one
    // at a time instead of being materialized as one tall libvips image.
    limitInputPixels: false,
    failOn: 'warning',
  }).metadata();
  const pages = metadata.pages || 1;
  const height = metadata.pageHeight || metadata.height / pages;
  validateStaticImageSize(metadata.width || 0, height);
  if (!Number.isInteger(height) || pages < 2) {
    throw new Error('动图元数据无效');
  }
  return {
    width: metadata.width || 0,
    height,
    pages,
    delay: Array.from(
      { length: pages },
      (_, index) => Math.max(20, metadata.delay?.[index] || 100),
    ),
    loop: metadata.loop ?? 0,
    format: kind.format,
  };
}

export async function inspectSourceImage(input, recipe) {
  if (!input || input.length === 0) throw new Error('下载的图片为空');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = detectImageKind(bytes);
  const animation = kind.animated
    ? await inspectAnimation(bytes, kind)
    : null;
  let image = animation;
  if (!image) {
    const metadata = await sharp(bytes, {
      page: 0,
      pages: 1,
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'warning',
    }).metadata();
    validateStaticImageSize(metadata.width || 0, metadata.height || 0);
    image = {
      width: metadata.width || 0,
      height: metadata.height || 0,
      pages: 1,
      delay: [100],
      loop: 0,
      format: metadata.format || 'unknown',
    };
  }
  if (
    image.width !== recipe.source.width ||
    image.height !== recipe.source.height
  ) {
    throw new Error(
      `原图片尺寸不一致：配置 ${recipe.source.width}×${recipe.source.height}，实际 ${image.width}×${image.height}`,
    );
  }
  if (image.pages !== recipe.source.frames) {
    throw new Error(
      `原图片帧数不一致：配置 ${recipe.source.frames} 帧，实际 ${image.pages} 帧`,
    );
  }
  const contentRect = recipe.transport.contentRect;
  if (
    contentRect.x !== 0 ||
    contentRect.y !== 0 ||
    contentRect.width !== 1 ||
    contentRect.height !== 1
  ) {
    throw new Error('配置字符串不是原图直传格式，请在新版页面中重新生成');
  }
  return image;
}

export async function downloadMessageImage({
  messageId,
  imageKey,
  profile,
  runLark,
  workingDirectory = process.cwd(),
}) {
  const stagingRoot = downloadStagingRoot(workingDirectory);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(
    join(stagingRoot, 'request-'),
  );
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-download-'),
  );
  const stagingOutput = join(stagingDirectory, 'source-image.png');
  const relativeOutput = relative(workingDirectory, stagingOutput);
  if (
    isAbsolute(relativeOutput) ||
    relativeOutput === '..' ||
    relativeOutput.startsWith('../')
  ) {
    throw new Error('下载 staging 路径必须位于运行目录内');
  }
  const temporaryOutput = join(temporaryDirectory, 'source-image.png');
  try {
    await runLark([
      'im',
      '+messages-resources-download',
      '--profile',
      profile,
      '--as',
      'bot',
      '--message-id',
      messageId,
      '--file-key',
      imageKey,
      '--type',
      'image',
      '--output',
      relativeOutput,
      '--json',
    ]);
    await copyFile(stagingOutput, temporaryOutput);
    await unlink(stagingOutput);
    return await readFile(temporaryOutput);
  } finally {
    await Promise.all([
      rm(stagingDirectory, { recursive: true, force: true }),
      rm(temporaryDirectory, { recursive: true, force: true }),
    ]);
  }
}

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

import { decodeImageBytes } from '@lark-signature-buddy/core/animation';
import {
  detectImageKind,
  validateStaticImageSize,
} from '@lark-signature-buddy/core/image-format';
import { validateAnimationWork } from '@lark-signature-buddy/core/transport';

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

async function decodeAnimatedWebp(bytes) {
  const metadata = await sharp(bytes, {
    animated: true,
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'warning',
  }).metadata();
  const { data, info } = await sharp(bytes, {
    animated: true,
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'warning',
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pages = info.pages || 1;
  const height = info.pageHeight || info.height / pages;
  validateStaticImageSize(info.width, height);
  validateAnimationWork(info.width, height, pages);
  const frameBytes = info.width * height * 4;
  return {
    width: info.width,
    height,
    frames: Array.from({ length: pages }, (_, index) => {
      const start = index * frameBytes;
      return {
        data: new Uint8ClampedArray(
          data.buffer,
          data.byteOffset + start,
          frameBytes,
        ),
        delay: Math.max(20, metadata.delay?.[index] || 100),
      };
    }),
    loop: metadata.loop ?? 0,
  };
}

export async function inspectSourceImage(input, recipe) {
  if (!input || input.length === 0) throw new Error('下载的图片为空');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = detectImageKind(bytes);
  const animation = kind.animated
    ? kind.format === 'webp'
      ? await decodeAnimatedWebp(bytes)
      : await decodeImageBytes(bytes)
    : null;
  let image;
  if (animation) {
    image = {
      ...animation,
      pages: animation.frames.length,
      delay: animation.frames.map((frame) => frame.delay),
      format: kind.format,
    };
  } else {
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

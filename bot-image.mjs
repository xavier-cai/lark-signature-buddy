import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import jsQR from 'jsqr';
import sharp from 'sharp';

import { decodeImageRecipe } from './public/image-recipe.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 80 * 1024 * 1024;

export async function decodeRecipeFromImage(input) {
  if (!input || input.length === 0) throw new Error('下载的图片为空');
  if (input.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MB 处理上限');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  const animatedImage = sharp(bytes, {
    animated: true,
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'warning',
  });
  const metadata = await animatedImage.metadata();
  const width = metadata.width || 0;
  const pageHeight = metadata.pageHeight || metadata.height || 0;
  const pages = metadata.pages || 1;
  const scanHeight = Math.min(pageHeight, 1024);
  let scanner = sharp(bytes, {
    page: 0,
    pages: 1,
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'warning',
  }).extract({
    left: 0,
    top: pageHeight - scanHeight,
    width,
    height: scanHeight,
  });
  if (width > 2048) scanner = scanner.resize({ width: 2048 });
  const { data, info } = await scanner
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  const qr = jsQR(pixels, info.width, info.height, {
    inversionAttempts: 'dontInvert',
  });
  if (!qr?.data) throw new Error('未识别到 Image Buddy QR 参数');
  const recipe = decodeImageRecipe(qr.data);
  if (recipe.source.frames !== pages) {
    throw new Error(
      `动图帧数不一致：参数 ${recipe.source.frames} 帧，飞书下载结果 ${pages} 帧`,
    );
  }

  return {
    recipe,
    token: qr.data,
    image: {
      width,
      height: pageHeight,
      pages,
      delay: metadata.delay || [100],
      loop: metadata.loop ?? 0,
      format: metadata.format || 'unknown',
    },
  };
}

export async function downloadMessageImage({
  messageId,
  imageKey,
  profile,
  runLark,
}) {
  const directory = await mkdtemp('.image-buddy-');
  const output = join(directory, 'source-image');
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
      output,
      '--json',
    ]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import jsQR from 'jsqr';
import sharp from 'sharp';

import { decodeImageRecipe } from './public/image-recipe.js';
import { isAnimatedImageBytes } from './public/image-format.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40 * 1024 * 1024;

export async function decodeRecipeFromImage(input) {
  if (!input || input.length === 0) throw new Error('下载的图片为空');
  if (input.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MB 处理上限');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isAnimatedImageBytes(bytes)) throw new Error('当前 V1 暂不支持动图');

  const image = sharp(bytes, {
    animated: false,
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'warning',
  });
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const scanHeight = Math.min(height, 1024);
  let scanner = image.extract({
    left: 0,
    top: height - scanHeight,
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

  return {
    recipe: decodeImageRecipe(qr.data),
    token: qr.data,
    image: {
      width,
      height,
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
  const output = join(directory, 'source-image.png');
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

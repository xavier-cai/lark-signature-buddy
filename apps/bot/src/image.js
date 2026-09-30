import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import jsQR from 'jsqr';
import sharp from 'sharp';

import { decodeImageBytes } from '@lark-signature-buddy/core/animation';
import { detectImageKind } from '@lark-signature-buddy/core/image-format';
import { decodeSignatureRecipe } from '@lark-signature-buddy/core/recipe';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 80 * 1024 * 1024;

export async function decodeRecipeFromImage(input) {
  if (!input || input.length === 0) throw new Error('下载的图片为空');
  if (input.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MB 处理上限');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = detectImageKind(bytes);
  const animation =
    kind.animated ? await decodeImageBytes(bytes) : null;
  let width;
  let pageHeight;
  let pages;
  let delays;
  let loop;
  let format;
  let scanner;
  if (animation) {
    width = animation.width;
    pageHeight = animation.height;
    pages = animation.frames.length;
    delays = animation.frames.map((frame) => frame.delay);
    loop = animation.loop;
    scanner = sharp(Buffer.from(animation.frames[0].data), {
      raw: {
        width,
        height: pageHeight,
        channels: 4,
      },
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'warning',
    });
    format = kind.format;
  } else {
    scanner = sharp(bytes, {
      page: 0,
      pages: 1,
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'warning',
    });
    const metadata = await scanner.metadata();
    width = metadata.width || 0;
    pageHeight = metadata.height || 0;
    pages = 1;
    delays = [100];
    loop = 0;
    format = metadata.format || 'unknown';
  }
  const scanHeight = Math.min(pageHeight, 1024);
  scanner = scanner.extract({
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
  if (!qr?.data) throw new Error('未识别到 Lark Signature Buddy QR 参数');
  const recipe = decodeSignatureRecipe(qr.data);
  if (recipe.source.animated && kind.format !== 'gif') {
    throw new Error(
      '动图传输图已被复制链路转成静态图片；请从页面下载 GIF 文件后作为图片上传，不要右键复制',
    );
  }
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
      delay: delays,
      loop,
      format,
    },
  };
}

export async function downloadMessageImage({
  messageId,
  imageKey,
  profile,
  runLark,
}) {
  const directory = await mkdtemp(
    join(tmpdir(), 'lark-signature-buddy-download-'),
  );
  // lark-cli appends an extension inferred from Content-Type when --output has
  // none, so always provide one and keep the path deterministic for readFile.
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

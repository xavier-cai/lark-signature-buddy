import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeImageRecipe } from './public/image-recipe.js';
import { isAnimatedImageBytes } from './public/image-format.js';
import { extractRecipeFromPng } from './public/png-recipe.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function readPngSize(bytes) {
  if (bytes.length < 24) throw new Error('PNG 文件不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

export async function decodeRecipeFromImage(input) {
  if (!input || input.length === 0) throw new Error('下载的图片为空');
  if (input.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MB 处理上限');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isAnimatedImageBytes(bytes)) throw new Error('当前 V1 暂不支持动图');
  const token = extractRecipeFromPng(bytes);
  const recipe = decodeImageRecipe(token);
  const image = readPngSize(bytes);
  if (
    image.width !== recipe.source.width ||
    image.height !== recipe.source.height
  ) {
    throw new Error(
      `PNG 尺寸 ${image.width}×${image.height} 与参数 ${recipe.source.width}×${recipe.source.height} 不一致`,
    );
  }
  return {
    recipe,
    token,
    image: { ...image, format: 'png' },
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

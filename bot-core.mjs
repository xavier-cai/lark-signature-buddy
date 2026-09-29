import {
  decodeImageRecipe,
  extractImageRecipeTokens,
} from './public/image-recipe.js';

const IMAGE_KEY_PATTERN = /\bimg_[A-Za-z0-9_-]+\b/g;

export function extractImageKeys(content) {
  const values = [];

  function visit(value) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(IMAGE_KEY_PATTERN)) {
        values.push(match[0]);
      }
      try {
        const parsed = JSON.parse(value);
        if (parsed !== value) visit(parsed);
      } catch {
        // Human-readable event content is expected for most message types.
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  }

  visit(content);
  return [...new Set(values)];
}

export function eventBatchKey(event) {
  const chatId = event.chat_id || 'unknown-chat';
  const senderId = event.sender_id || 'unknown-sender';
  const contextId = event.thread_id || event.root_id || 'main';
  return `${chatId}:${senderId}:${contextId}`;
}

export function formatReply(imageKeys) {
  const uniqueKeys = [...new Set(imageKeys)];
  const heading =
    uniqueKeys.length === 1
      ? '收到 1 张图片：'
      : `收到 ${uniqueKeys.length} 张图片：`;
  const lines = [heading, ''];
  uniqueKeys.forEach((key, index) => {
    lines.push(`${index + 1}. ${key}`);
    lines.push(`https://magic.solutionsuite.cn/r?k=${encodeURIComponent(key)}`);
    if (index < uniqueKeys.length - 1) lines.push('');
  });
  return lines.join('\n');
}

export function extractImageRecipe(content) {
  const tokens = extractImageRecipeTokens(content);
  if (tokens.length === 0) return null;
  if (tokens.length !== 1) {
    throw new Error(`切图参数无效：期望 1 份 recipe，收到 ${tokens.length} 份`);
  }
  return decodeImageRecipe(tokens[0]);
}

export function formatRecipeReceipt(imageKeys, recipe, transportImage = null) {
  const uniqueKeys = [...new Set(imageKeys)];
  if (uniqueKeys.length !== 1) {
    return `切图请求无效：期望 1 张原图，收到 ${uniqueKeys.length} 张。`;
  }
  const { source, grid, crop, mode, gapRatio, output } = recipe;
  const lines = [
    '切图参数读取成功（当前仅验证，不执行切图）：',
    '',
    `传输图 image_key：${uniqueKeys[0]}`,
    `协议：${recipe.protocol} V${recipe.version}`,
    `原图尺寸：${source.width} × ${source.height}`,
    `网格：${grid.cols} × ${grid.rows}（${grid.cols * grid.rows} 张）`,
    `选区：x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}`,
    `模式：${mode}`,
    `间隔比例：${gapRatio}`,
    `输出：${output.width} × ${output.height} ${output.format.toUpperCase()}`,
  ];
  if (transportImage) {
    lines.push(
      `传输图片：${transportImage.width} × ${transportImage.height} ${transportImage.format.toUpperCase()}`,
    );
  }
  return lines.join('\n');
}

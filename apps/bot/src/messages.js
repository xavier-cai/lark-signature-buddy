const IMAGE_KEY_PATTERN =
  /(?<![A-Za-z0-9_-])img_[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const RECIPE_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_-])LSB\d+:[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;

function extractMatches(content, pattern) {
  const values = [];

  function visit(value) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(pattern)) {
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

export function extractImageKeys(content) {
  return extractMatches(content, IMAGE_KEY_PATTERN);
}

export function extractRecipeTokens(content) {
  return extractMatches(content, RECIPE_TOKEN_PATTERN);
}

export function eventBatchKey(event) {
  const chatId = event.chat_id || 'unknown-chat';
  const senderId = event.sender_id || 'unknown-sender';
  const contextId = event.thread_id || event.root_id || 'main';
  return `${chatId}:${senderId}:${contextId}`;
}

export function formatRecipeReceipt(imageKeys, recipe, sourceImage = null) {
  const uniqueKeys = [...new Set(imageKeys)];
  if (uniqueKeys.length !== 1) {
    return `切图请求无效：期望 1 张原图，收到 ${uniqueKeys.length} 张。`;
  }
  const { source, grid, crop, mode, gapRatio, output } = recipe;
  const { contentRect } = recipe.transport;
  const lines = [
    '切图参数读取成功（当前仅验证，不执行切图）：',
    '',
    `原图片 image_key：${uniqueKeys[0]}`,
    `协议：${recipe.protocol} V${recipe.version}`,
    `原图尺寸：${source.width} × ${source.height}`,
    `帧数：${source.frames}${source.animated ? '（动图）' : '（静态）'}`,
    `网格：${grid.cols} × ${grid.rows}（${grid.cols * grid.rows} 张）`,
    `选区：x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}`,
    `模式：${mode}`,
    `间隔比例：${gapRatio}`,
    `色彩映射：${recipe.colorMapping ? '开启' : '关闭'}`,
    `色彩映射 gamma：${recipe.colorMappingGamma}`,
    `输出：${output.width} × ${output.height} ${output.format.toUpperCase()}`,
    `原图区域：x=${contentRect.x}, y=${contentRect.y}, width=${contentRect.width}, height=${contentRect.height}`,
  ];
  if (sourceImage) {
    lines.push(
      `原图片：${sourceImage.width} × ${sourceImage.height} ${sourceImage.format.toUpperCase()}`,
    );
  }
  return lines.join('\n');
}

export function formatGeneratedReply(imageKeys, recipe) {
  const expected = recipe.grid.cols * recipe.grid.rows;
  if (imageKeys.length !== expected) {
    throw new Error(
      `切片结果数量异常：期望 ${expected} 张，实际 ${imageKeys.length} 张`,
    );
  }
  const links = imageKeys.map((key, index) => {
    const isRowEnd = (index + 1) % recipe.grid.cols === 0;
    return `https://magic.solutionsuite.cn/r?k=${encodeURIComponent(key)}${isRowEnd ? '&t2=A' : ''}`;
  });
  const previewLinks = Array.from(
    { length: recipe.grid.rows },
    (_, row) =>
      links
        .slice(row * recipe.grid.cols, (row + 1) * recipe.grid.cols)
        .join(' '),
  ).join('\n');
  const copyLinks = links.join(' ');
  return [
    `切图完成：${recipe.grid.cols} × ${recipe.grid.rows}，共 ${expected} 张。`,
    '顺序：从左到右、从上到下。',
    '',
    '预览：',
    previewLinks,
    '',
    '复制：',
    '```text',
    copyLinks,
    '```',
  ].join('\n');
}

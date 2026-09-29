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

export function formatRecipeReceipt(imageKeys, recipe, transportImage = null) {
  const uniqueKeys = [...new Set(imageKeys)];
  if (uniqueKeys.length !== 1) {
    return `切图请求无效：期望 1 张原图，收到 ${uniqueKeys.length} 张。`;
  }
  const { source, grid, crop, mode, gapRatio, output } = recipe;
  const { contentRect } = recipe.transport;
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
    `原图区域：x=${contentRect.x}, y=${contentRect.y}, width=${contentRect.width}, height=${contentRect.height}`,
  ];
  if (transportImage) {
    lines.push(
      `传输图片：${transportImage.width} × ${transportImage.height} ${transportImage.format.toUpperCase()}`,
    );
  }
  return lines.join('\n');
}

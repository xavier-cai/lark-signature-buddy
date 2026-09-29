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


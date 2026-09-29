const MAX_IMAGE_EDGE = 8192;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;

export function validateStaticImageSize(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error('图片尺寸无效');
  }
  if (
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('图片尺寸过大，当前 V2 上限为 8192 px / 32 MP');
  }
}

export function isAnimatedImageBytes(bytes) {
  return detectImageKind(bytes).animated;
}

export function detectImageKind(bytes) {
  const ascii = (start, length) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (ascii(0, 3) === 'GIF') return { format: 'gif', animated: true };
  if (ascii(1, 3) === 'PNG') {
    for (let index = 8; index + 8 <= bytes.length; ) {
      const length =
        ((bytes[index] << 24) |
          (bytes[index + 1] << 16) |
          (bytes[index + 2] << 8) |
          bytes[index + 3]) >>>
        0;
      if (ascii(index + 4, 4) === 'acTL') {
        return { format: 'apng', animated: true };
      }
      index += 12 + length;
    }
    return { format: 'png', animated: false };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    for (let index = 12; index + 8 <= bytes.length; ) {
      const chunk = ascii(index, 4);
      const length =
        bytes[index + 4] |
        (bytes[index + 5] << 8) |
        (bytes[index + 6] << 16) |
        (bytes[index + 7] << 24);
      if (chunk === 'ANIM' || chunk === 'ANMF') {
        return { format: 'webp', animated: true };
      }
      index += 8 + length + (length % 2);
    }
    return { format: 'webp', animated: false };
  }
  return { format: 'static', animated: false };
}

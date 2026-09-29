export const IMAGE_RECIPE_NAME = 'image-buddy-recipe';
export const IMAGE_RECIPE_VERSION = 4;
export const IMAGE_RECIPE_PREFIX = `IB${IMAGE_RECIPE_VERSION}:`;
export const IMAGE_RECIPE_BYTE_LENGTH = 41;
export const IMAGE_RECIPE_TOKEN_MAX_LENGTH = 64;

const MODE_TO_CODE = new Map([
  ['plain', 0],
  ['precut', 1],
]);
const FORMAT_TO_CODE = new Map([
  ['png', 0],
  ['apng', 1],
]);
const NORMALIZED_MAX = 65535;

function fail(message) {
  throw new Error(`切图参数无效：${message}`);
}

function assertExactKeys(value, expected, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} 必须是对象`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${path} 字段必须为 ${wanted.join(', ')}`);
  }
}

function assertInteger(value, min, max, path) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${path} 必须是 ${min}–${max} 的整数`);
  }
}

function assertNumber(value, min, max, path) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`${path} 必须在 ${min}–${max} 之间`);
  }
}

function assertRect(rect, path) {
  assertExactKeys(rect, ['x', 'y', 'width', 'height'], path);
  assertNumber(rect.x, 0, 1, `${path}.x`);
  assertNumber(rect.y, 0, 1, `${path}.y`);
  assertNumber(rect.width, 0, 1, `${path}.width`);
  assertNumber(rect.height, 0, 1, `${path}.height`);
  if (rect.width === 0 || rect.height === 0) fail(`${path} 尺寸不能为 0`);
  if (rect.x + rect.width > 1.00002) fail(`${path} 超出右边界`);
  if (rect.y + rect.height > 1.00002) fail(`${path} 超出下边界`);
}

function round(value) {
  return Number(value.toFixed(8));
}

function normalizedToUint16(value) {
  return Math.round(value * NORMALIZED_MAX);
}

function uint16ToNormalized(value) {
  return round(value / NORMALIZED_MAX);
}

function quantizeNormalized(value) {
  return uint16ToNormalized(normalizedToUint16(value));
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    fail('编码格式错误');
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    fail('编码无法解码');
  }
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateImageRecipe(value) {
  assertExactKeys(
    value,
    [
      'protocol',
      'version',
      'source',
      'grid',
      'crop',
      'mode',
      'gapRatio',
      'colorMapping',
      'output',
      'transport',
    ],
    'payload',
  );
  if (value.protocol !== IMAGE_RECIPE_NAME) fail(`protocol 必须是 ${IMAGE_RECIPE_NAME}`);
  if (value.version !== IMAGE_RECIPE_VERSION) {
    fail(`仅支持 V${IMAGE_RECIPE_VERSION}，收到 V${String(value.version)}`);
  }

  assertExactKeys(value.source, ['width', 'height', 'animated', 'frames'], 'source');
  assertInteger(value.source.width, 1, 100000, 'source.width');
  assertInteger(value.source.height, 1, 100000, 'source.height');
  if (typeof value.source.animated !== 'boolean') {
    fail('source.animated 必须是 boolean');
  }
  assertInteger(value.source.frames, 1, 120, 'source.frames');
  if (value.source.animated !== (value.source.frames > 1)) {
    fail('source.animated 与 source.frames 不一致');
  }

  assertExactKeys(value.grid, ['cols', 'rows'], 'grid');
  assertInteger(value.grid.cols, 1, 15, 'grid.cols');
  assertInteger(value.grid.rows, 1, 15, 'grid.rows');
  assertRect(value.crop, 'crop');

  if (!MODE_TO_CODE.has(value.mode)) fail('mode 必须是 plain 或 precut');
  assertNumber(value.gapRatio, 0, 1, 'gapRatio');
  if (typeof value.colorMapping !== 'boolean') {
    fail('colorMapping 必须是 boolean');
  }

  assertExactKeys(value.output, ['width', 'height', 'format'], 'output');
  assertInteger(value.output.width, 1, 4096, 'output.width');
  assertInteger(value.output.height, 1, 4096, 'output.height');
  if (value.output.width !== value.output.height) fail('V4 仅支持正方形输出');
  if (!FORMAT_TO_CODE.has(value.output.format)) {
    fail('output.format 必须是 png 或 apng');
  }
  if (value.source.animated !== (value.output.format === 'apng')) {
    fail('静态输入必须输出 png，动图输入必须输出 apng');
  }
  assertExactKeys(value.transport, ['contentRect'], 'transport');
  assertRect(value.transport.contentRect, 'transport.contentRect');
  return value;
}

export function createImageRecipe({
  sourceWidth,
  sourceHeight,
  sourceFrames,
  cols,
  rows,
  crop,
  mode,
  gapRatio,
  colorMapping,
  outputSize,
  contentRect,
}) {
  return validateImageRecipe({
    protocol: IMAGE_RECIPE_NAME,
    version: IMAGE_RECIPE_VERSION,
    source: {
      width: sourceWidth,
      height: sourceHeight,
      animated: sourceFrames > 1,
      frames: sourceFrames,
    },
    grid: { cols, rows },
    crop: {
      x: quantizeNormalized(crop.x),
      y: quantizeNormalized(crop.y),
      width: quantizeNormalized(crop.width),
      height: quantizeNormalized(crop.height),
    },
    mode,
    gapRatio: quantizeNormalized(gapRatio),
    colorMapping,
    output: {
      width: outputSize,
      height: outputSize,
      format: sourceFrames > 1 ? 'apng' : 'png',
    },
    transport: {
      contentRect: {
        x: quantizeNormalized(contentRect.x),
        y: quantizeNormalized(contentRect.y),
        width: quantizeNormalized(contentRect.width),
        height: quantizeNormalized(contentRect.height),
      },
    },
  });
}

export function encodeImageRecipe(recipe) {
  const value = validateImageRecipe(recipe);
  const bytes = new Uint8Array(IMAGE_RECIPE_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x42;
  bytes[2] = IMAGE_RECIPE_VERSION;
  bytes[3] =
    MODE_TO_CODE.get(value.mode) |
    (value.colorMapping ? 0x40 : 0) |
    (value.source.animated ? 0x80 : 0);
  view.setUint32(4, value.source.width);
  view.setUint32(8, value.source.height);
  bytes[12] = value.grid.cols;
  bytes[13] = value.grid.rows;
  const normalized = [
    value.crop.x,
    value.crop.y,
    value.crop.width,
    value.crop.height,
    value.gapRatio,
    value.transport.contentRect.x,
    value.transport.contentRect.y,
    value.transport.contentRect.width,
    value.transport.contentRect.height,
  ];
  normalized.forEach((number, index) => {
    view.setUint16(14 + index * 2, normalizedToUint16(number));
  });
  view.setUint16(32, value.output.width);
  bytes[34] = FORMAT_TO_CODE.get(value.output.format);
  view.setUint16(35, value.source.frames);
  view.setUint32(37, crc32(bytes.subarray(0, 37)));
  const token = `${IMAGE_RECIPE_PREFIX}${encodeBase64Url(bytes)}`;
  if (token.length > IMAGE_RECIPE_TOKEN_MAX_LENGTH) fail('编码超过长度上限');
  return token;
}

export function decodeImageRecipe(token) {
  const match = /^IB(\d+):([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) fail('缺少完整协议标记');
  const markerVersion = Number(match[1]);
  if (markerVersion !== IMAGE_RECIPE_VERSION) {
    fail(`仅支持 V${IMAGE_RECIPE_VERSION}，收到 V${markerVersion}`);
  }
  const bytes = decodeBase64Url(match[2]);
  if (bytes.length !== IMAGE_RECIPE_BYTE_LENGTH) {
    fail(`payload 长度应为 ${IMAGE_RECIPE_BYTE_LENGTH} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x49 || bytes[1] !== 0x42) fail('magic 不匹配');
  if (bytes[2] !== markerVersion) fail('协议标记与 payload 版本不一致');
  if (view.getUint32(37) !== crc32(bytes.subarray(0, 37))) fail('CRC32 校验失败');
  const modeCode = bytes[3] & 0x3f;
  const mode = [...MODE_TO_CODE].find(([, code]) => code === modeCode)?.[0];
  if (!mode) fail('mode 编码未知');
  const format = [...FORMAT_TO_CODE].find(([, code]) => code === bytes[34])?.[0];
  if (!format) fail('output.format 编码未知');

  const normalized = Array.from({ length: 9 }, (_, index) =>
    uint16ToNormalized(view.getUint16(14 + index * 2)),
  );
  return validateImageRecipe({
    protocol: IMAGE_RECIPE_NAME,
    version: bytes[2],
    source: {
      width: view.getUint32(4),
      height: view.getUint32(8),
      animated: Boolean(bytes[3] & 0x80),
      frames: view.getUint16(35),
    },
    grid: { cols: bytes[12], rows: bytes[13] },
    crop: {
      x: normalized[0],
      y: normalized[1],
      width: normalized[2],
      height: normalized[3],
    },
    mode,
    gapRatio: normalized[4],
    colorMapping: Boolean(bytes[3] & 0x40),
    output: {
      width: view.getUint16(32),
      height: view.getUint16(32),
      format,
    },
    transport: {
      contentRect: {
        x: normalized[5],
        y: normalized[6],
        width: normalized[7],
        height: normalized[8],
      },
    },
  });
}

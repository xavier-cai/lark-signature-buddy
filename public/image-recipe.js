export const IMAGE_RECIPE_NAME = 'image-buddy-recipe';
export const IMAGE_RECIPE_VERSION = 1;
export const IMAGE_RECIPE_PREFIX = `IMAGE_BUDDY_RECIPE_V${IMAGE_RECIPE_VERSION}:`;

const TOKEN_PATTERN = /\bIMAGE_BUDDY_RECIPE_V(\d+):([^\s<>"']+)/g;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MODES = new Set(['plain', 'precut']);
const FORMATS = new Set(['png']);

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

function round(value) {
  return Number(value.toFixed(8));
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value) {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    fail('编码格式错误');
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  let binary;
  try {
    binary = atob(padded);
  } catch {
    fail('编码无法解码');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('编码不是 UTF-8');
  }
}

export function validateImageRecipe(value) {
  assertExactKeys(
    value,
    ['protocol', 'version', 'source', 'grid', 'crop', 'mode', 'gapRatio', 'output'],
    'payload',
  );
  if (value.protocol !== IMAGE_RECIPE_NAME) fail(`protocol 必须是 ${IMAGE_RECIPE_NAME}`);
  if (value.version !== IMAGE_RECIPE_VERSION) {
    fail(`仅支持 V${IMAGE_RECIPE_VERSION}，收到 V${String(value.version)}`);
  }

  assertExactKeys(value.source, ['width', 'height'], 'source');
  assertInteger(value.source.width, 1, 100000, 'source.width');
  assertInteger(value.source.height, 1, 100000, 'source.height');

  assertExactKeys(value.grid, ['cols', 'rows'], 'grid');
  assertInteger(value.grid.cols, 1, 15, 'grid.cols');
  assertInteger(value.grid.rows, 1, 15, 'grid.rows');

  assertExactKeys(value.crop, ['x', 'y', 'width', 'height'], 'crop');
  assertNumber(value.crop.x, 0, 1, 'crop.x');
  assertNumber(value.crop.y, 0, 1, 'crop.y');
  assertNumber(value.crop.width, 0, 1, 'crop.width');
  assertNumber(value.crop.height, 0, 1, 'crop.height');
  if (value.crop.width === 0 || value.crop.height === 0) fail('crop 尺寸不能为 0');
  if (value.crop.x + value.crop.width > 1.00000001) fail('crop 超出图片右边界');
  if (value.crop.y + value.crop.height > 1.00000001) fail('crop 超出图片下边界');

  if (!MODES.has(value.mode)) fail('mode 必须是 plain 或 precut');
  assertNumber(value.gapRatio, 0, 1, 'gapRatio');

  assertExactKeys(value.output, ['width', 'height', 'format'], 'output');
  assertInteger(value.output.width, 1, 4096, 'output.width');
  assertInteger(value.output.height, 1, 4096, 'output.height');
  if (!FORMATS.has(value.output.format)) fail('output.format 必须是 png');

  return value;
}

export function createImageRecipe({
  sourceWidth,
  sourceHeight,
  cols,
  rows,
  crop,
  mode,
  gapRatio,
  outputSize,
}) {
  return validateImageRecipe({
    protocol: IMAGE_RECIPE_NAME,
    version: IMAGE_RECIPE_VERSION,
    source: {
      width: sourceWidth,
      height: sourceHeight,
    },
    grid: { cols, rows },
    crop: {
      x: round(crop.x),
      y: round(crop.y),
      width: round(crop.width),
      height: round(crop.height),
    },
    mode,
    gapRatio: round(gapRatio),
    output: {
      width: outputSize,
      height: outputSize,
      format: 'png',
    },
  });
}

export function encodeImageRecipe(recipe) {
  const validated = validateImageRecipe(recipe);
  return `${IMAGE_RECIPE_PREFIX}${encodeBase64Url(JSON.stringify(validated))}`;
}

export function decodeImageRecipe(token) {
  const match = /^IMAGE_BUDDY_RECIPE_V(\d+):([^\s]+)$/.exec(token);
  if (!match) fail('缺少完整协议标记');
  const markerVersion = Number(match[1]);
  if (markerVersion !== IMAGE_RECIPE_VERSION) {
    fail(`仅支持 V${IMAGE_RECIPE_VERSION}，收到 V${markerVersion}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(decodeBase64Url(match[2]));
  } catch (error) {
    if (error.message.startsWith('切图参数无效：')) throw error;
    fail('payload 不是合法 JSON');
  }
  if (parsed.version !== markerVersion) fail('协议标记与 payload 版本不一致');
  return validateImageRecipe(parsed);
}

export function extractImageRecipeTokens(content) {
  const tokens = [];

  function visit(value) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(TOKEN_PATTERN)) tokens.push(match[0]);
      try {
        const parsed = JSON.parse(value);
        if (parsed !== value) visit(parsed);
      } catch {
        // Event content is frequently a human-readable string rather than JSON.
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
  return [...new Set(tokens)];
}

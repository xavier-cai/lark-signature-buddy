export const DEFAULT_COLOR_MAPPING_GAMMA = 1;
export const LARK_SIGNATURE_BLUE = [51, 112, 255];

function assertRgbaBuffer(source, output) {
  if (!ArrayBuffer.isView(source) || source.length % 4 !== 0) {
    throw new Error('RGBA 像素数据无效');
  }
  if (!ArrayBuffer.isView(output) || output.length !== source.length) {
    throw new Error('色彩映射输出缓冲区尺寸无效');
  }
}

function assertGamma(gamma) {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 3) {
    throw new Error('色彩映射 gamma 必须在 0–3 之间');
  }
}

/**
 * G(P): preprocessing we control before uploading a tile to Lark.
 *
 * Alpha always follows the official luminance-to-alpha transform. Gamma only
 * brightens or darkens the grayscale RGB channel used by the PC renderer, so
 * mobile output (which discards RGB) remains unchanged.
 */
export function preprocessLarkSignature(
  source,
  output = new Uint8ClampedArray(source.length),
  gamma = DEFAULT_COLOR_MAPPING_GAMMA,
) {
  assertRgbaBuffer(source, output);
  assertGamma(gamma);

  for (let index = 0; index < source.length; index += 4) {
    const luminance = Math.floor(
      0.2126 * source[index] +
      0.7152 * source[index + 1] +
      0.0722 * source[index + 2],
    );
    const adjustedLuminance = Math.round(
      255 * ((luminance / 255) ** gamma),
    );
    output[index] = adjustedLuminance;
    output[index + 1] = adjustedLuminance;
    output[index + 2] = adjustedLuminance;
    output[index + 3] = Math.floor(
      ((255 - luminance) * source[index + 3]) / 255,
    );
  }
  return output;
}

export function mapToLuminanceAlpha(
  source,
  output = new Uint8ClampedArray(source.length),
  gamma = 1,
) {
  return preprocessLarkSignature(source, output, gamma);
}

function assertColor(color) {
  if (
    !Array.isArray(color) ||
    color.length !== 3 ||
    color.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new Error('遮罩颜色必须是 3 个 0–255 整数');
  }
}

/**
 * F_PC(G(P)): PC keeps G's grayscale RGB and multiplies it by the Lark tint.
 * Alpha is preserved. The browser background performs the final compositing.
 */
export function renderLarkPc(
  source,
  color = LARK_SIGNATURE_BLUE,
  output = new Uint8ClampedArray(source.length),
) {
  assertRgbaBuffer(source, output);
  assertColor(color);
  for (let index = 0; index < output.length; index += 4) {
    output[index] = Math.round((source[index] * color[0]) / 255);
    output[index + 1] = Math.round((source[index + 1] * color[1]) / 255);
    output[index + 2] = Math.round((source[index + 2] * color[2]) / 255);
    output[index + 3] = source[index + 3];
  }
  return output;
}

/**
 * F_mobile(G(P)): mobile discards G's RGB channel and applies a flat Lark
 * tint, preserving only alpha. Mobile link previews are also first-frame only.
 */
export function renderLarkMobile(
  source,
  color = LARK_SIGNATURE_BLUE,
  output = new Uint8ClampedArray(source.length),
) {
  assertRgbaBuffer(source, output);
  assertColor(color);
  for (let index = 0; index < output.length; index += 4) {
    output[index] = color[0];
    output[index + 1] = color[1];
    output[index + 2] = color[2];
    output[index + 3] = source[index + 3];
  }
  return output;
}

// Backward-compatible helper: preprocess with the official gamma=1 curve and
// then apply the mobile-style flat tint.

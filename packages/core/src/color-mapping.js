export function mapToLuminanceAlpha(
  source,
  output = new Uint8ClampedArray(source.length),
) {
  if (!ArrayBuffer.isView(source) || source.length % 4 !== 0) {
    throw new Error('RGBA 像素数据无效');
  }
  if (!ArrayBuffer.isView(output) || output.length !== source.length) {
    throw new Error('色彩映射输出缓冲区尺寸无效');
  }

  for (let index = 0; index < source.length; index += 4) {
    const luminance = Math.floor(
      0.2126 * source[index] +
      0.7152 * source[index + 1] +
      0.0722 * source[index + 2],
    );
    output[index] = luminance;
    output[index + 1] = luminance;
    output[index + 2] = luminance;
    output[index + 3] = Math.floor(
      ((255 - luminance) * source[index + 3]) / 255,
    );
  }
  return output;
}

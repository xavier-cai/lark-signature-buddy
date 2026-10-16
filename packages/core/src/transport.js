export const MAX_FULL_DECODE_BYTES = 320 * 1024 * 1024;

export function validateFullDecodeMemory(width, height, frames) {
  if (!Number.isInteger(frames) || frames < 1) {
    throw new Error('动图帧数无效');
  }
  if (width * height * frames * 4 > MAX_FULL_DECODE_BYTES) {
    throw new Error('当前解码路径预计需要超过 320 MiB RGBA 内存');
  }
}

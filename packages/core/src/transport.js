export const MAX_ANIMATION_PIXEL_WORK = 80 * 1024 * 1024;

export function validateAnimationWork(width, height, frames) {
  if (!Number.isInteger(frames) || frames < 1) {
    throw new Error('动图帧数无效');
  }
  if (width * height * frames > MAX_ANIMATION_PIXEL_WORK) {
    throw new Error('动图总像素工作量超过 80 MP 上限');
  }
}

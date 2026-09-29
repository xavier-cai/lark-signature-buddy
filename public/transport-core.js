export const TRANSPORT_MIN_WIDTH = 384;
export const QR_QUIET_ZONE_MODULES = 4;
export const QR_MIN_MODULE_PIXELS = 1;
export const MAX_TRANSPORT_EDGE = 8192;
export const MAX_TRANSPORT_PIXELS = 32 * 1024 * 1024;
export const MAX_ANIMATION_FRAMES = 120;
export const MAX_ANIMATION_PIXEL_WORK = 80 * 1024 * 1024;

export function qrSizeForModules(moduleCount) {
  if (!Number.isInteger(moduleCount) || moduleCount < 1) {
    throw new Error('二维码 module 数无效');
  }
  return (
    (moduleCount + QR_QUIET_ZONE_MODULES * 2) * QR_MIN_MODULE_PIXELS
  );
}

export function transportLayoutForSource(sourceWidth, sourceHeight, qrSize) {
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    throw new Error('图片尺寸无效');
  }
  if (!Number.isInteger(qrSize) || qrSize < 1) {
    throw new Error('二维码尺寸无效');
  }
  const canvasWidth = Math.max(sourceWidth, TRANSPORT_MIN_WIDTH);
  const footerHeight = qrSize;
  const canvasHeight = sourceHeight + footerHeight;
  if (
    canvasWidth > MAX_TRANSPORT_EDGE ||
    canvasHeight > MAX_TRANSPORT_EDGE ||
    canvasWidth * canvasHeight > MAX_TRANSPORT_PIXELS
  ) {
    throw new Error('图片尺寸过大，当前 V4 传输画布上限为 8192 px / 32 MP');
  }
  return {
    canvasWidth,
    canvasHeight,
    sourceX: Math.round((canvasWidth - sourceWidth) / 2),
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    footerHeight,
    qrSize,
  };
}

export function validateAnimationWork(width, height, frames) {
  if (!Number.isInteger(frames) || frames < 1) {
    throw new Error('动图帧数无效');
  }
  if (frames > MAX_ANIMATION_FRAMES) {
    throw new Error(`动图超过 ${MAX_ANIMATION_FRAMES} 帧上限`);
  }
  if (width * height * frames > MAX_ANIMATION_PIXEL_WORK) {
    throw new Error('动图总像素工作量超过 80 MP 上限');
  }
}

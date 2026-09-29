export const TRANSPORT_MIN_WIDTH = 384;
export const QR_MIN_SIZE = 256;
export const QR_MAX_SIZE = 768;
export const QR_MARGIN = 24;
export const QR_LABEL_HEIGHT = 32;
export const MAX_TRANSPORT_EDGE = 8192;
export const MAX_TRANSPORT_PIXELS = 32 * 1024 * 1024;

export function transportLayoutForSource(sourceWidth, sourceHeight) {
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    throw new Error('图片尺寸无效');
  }
  const canvasWidth = Math.max(sourceWidth, TRANSPORT_MIN_WIDTH);
  const qrSize = Math.min(
    QR_MAX_SIZE,
    Math.max(QR_MIN_SIZE, Math.ceil(canvasWidth / 48) * 4),
  );
  const footerHeight = qrSize + QR_MARGIN * 2 + QR_LABEL_HEIGHT;
  const canvasHeight = sourceHeight + footerHeight;
  if (
    canvasWidth > MAX_TRANSPORT_EDGE ||
    canvasHeight > MAX_TRANSPORT_EDGE ||
    canvasWidth * canvasHeight > MAX_TRANSPORT_PIXELS
  ) {
    throw new Error('图片尺寸过大，当前 V1 传输画布上限为 8192 px / 32 MP');
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

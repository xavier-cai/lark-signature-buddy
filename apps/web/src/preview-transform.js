export const MIN_PREVIEW_SCALE = 0.25;
export const MAX_PREVIEW_SCALE = 3;

export function clampPreviewScale(scale) {
  return Math.max(MIN_PREVIEW_SCALE, Math.min(MAX_PREVIEW_SCALE, scale));
}

export function zoomPreviewAtPoint(transform, factor, pointer) {
  const scale = clampPreviewScale(transform.scale * factor);
  const ratio = scale / transform.scale;
  return {
    scale,
    x: pointer.x - (pointer.x - transform.x) * ratio,
    y: pointer.y - (pointer.y - transform.y) * ratio,
  };
}

export function movePreview(transform, delta) {
  return {
    ...transform,
    x: transform.x + delta.x,
    y: transform.y + delta.y,
  };
}

export function isPreviewTransformReset(transform) {
  return transform.scale === 1 && transform.x === 0 && transform.y === 0;
}

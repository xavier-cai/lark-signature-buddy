export const FRAME_OPTION_WIDTH = 88;
export const FRAME_OPTION_GAP = 9;
export const FRAME_OPTION_STEP = FRAME_OPTION_WIDTH + FRAME_OPTION_GAP;

export function visibleFrameRange({
  scrollLeft,
  viewportWidth,
  frameCount,
  overscan = 6,
  initialCount = 20,
}) {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    return { start: 0, end: 0 };
  }
  const visibleStart = Math.floor(Math.max(0, scrollLeft) / FRAME_OPTION_STEP);
  const visibleEnd = Math.ceil(
    (Math.max(0, scrollLeft) + Math.max(1, viewportWidth)) /
      FRAME_OPTION_STEP,
  );
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(
    frameCount,
    Math.max(visibleEnd + overscan, scrollLeft === 0 ? initialCount : 0),
  );
  return { start, end };
}

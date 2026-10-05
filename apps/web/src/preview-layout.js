import { compositionUnits } from '@lark-signature-buddy/core/grid';

export const LARK_SIGNATURE_TILE_SIZE = 28;

export function previewLayout({
  cols,
  rows,
  gapRatio,
  availableWidth,
  actualSize,
  scale = 1,
}) {
  if (actualSize) {
    const tileSize = LARK_SIGNATURE_TILE_SIZE * scale;
    const gap = Math.round(tileSize * gapRatio);
    return {
      tileSize,
      gap,
      width: cols * tileSize + Math.max(0, cols - 1) * gap,
      height: rows * tileSize + Math.max(0, rows - 1) * gap,
    };
  }
  const width = Math.min(Math.max(80, availableWidth), 320) * scale;
  const { widthUnits, heightUnits } = compositionUnits(
    cols,
    rows,
    gapRatio,
  );
  const tileSize = width / widthUnits;
  return {
    tileSize,
    gap: tileSize * gapRatio,
    width,
    height: heightUnits * tileSize,
  };
}

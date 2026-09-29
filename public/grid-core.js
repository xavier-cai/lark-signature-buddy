export const GRID_OPTIONS = [
  { value: '1x2', cols: 1, rows: 2, label: '1 × 2' },
  { value: '2x1', cols: 2, rows: 1, label: '2 × 1' },
  { value: '2x2', cols: 2, rows: 2, label: '2 × 2' },
  { value: '2x3', cols: 2, rows: 3, label: '2 × 3' },
  { value: '3x2', cols: 3, rows: 2, label: '3 × 2' },
  { value: '3x3', cols: 3, rows: 3, label: '3 × 3' },
];

export function parseGrid(value) {
  const match = /^([1-3])x([1-3])$/.exec(value);
  if (!match) throw new Error(`Unsupported grid: ${value}`);
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

export function selectionAspect(cols, rows, mode, gapRatio) {
  if (mode !== 'precut') return cols / rows;
  const widthUnits = cols + Math.max(0, cols - 1) * gapRatio;
  const heightUnits = rows + Math.max(0, rows - 1) * gapRatio;
  return widthUnits / heightUnits;
}

export function fitCrop(imageWidth, imageHeight, aspect, coverage = 0.9) {
  const imageAspect = imageWidth / imageHeight;
  let width;
  let height;
  if (imageAspect >= aspect) {
    height = coverage;
    width = height * (aspect / imageAspect);
  } else {
    width = coverage;
    height = width * (imageAspect / aspect);
  }
  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  };
}

export function tileRects(crop, cols, rows, mode, gapRatio) {
  const useGap = mode === 'precut';
  const widthUnits = cols + (useGap ? Math.max(0, cols - 1) * gapRatio : 0);
  const heightUnits = rows + (useGap ? Math.max(0, rows - 1) * gapRatio : 0);
  const tileWidth = crop.width / widthUnits;
  const tileHeight = crop.height / heightUnits;
  const gapWidth = useGap ? tileWidth * gapRatio : 0;
  const gapHeight = useGap ? tileHeight * gapRatio : 0;
  const result = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      result.push({
        row,
        col,
        x: crop.x + col * (tileWidth + gapWidth),
        y: crop.y + row * (tileHeight + gapHeight),
        width: tileWidth,
        height: tileHeight,
      });
    }
  }
  return result;
}

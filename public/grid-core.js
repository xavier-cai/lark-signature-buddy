export function parseGrid(value) {
  const match = /^(\d{1,2})x(\d{1,2})$/.exec(value);
  if (!match) throw new Error(`Unsupported grid: ${value}`);
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols < 1 || cols > 15 || rows < 1 || rows > 15) {
    throw new Error(`Unsupported grid: ${value}`);
  }
  return { cols, rows };
}

export function selectionAspect(cols, rows, mode, gapRatio) {
  if (mode !== 'precut') return cols / rows;
  const { widthUnits, heightUnits } = compositionUnits(cols, rows, gapRatio);
  return widthUnits / heightUnits;
}

export function compositionUnits(cols, rows, gapRatio) {
  return {
    widthUnits: cols + Math.max(0, cols - 1) * gapRatio,
    heightUnits: rows + Math.max(0, rows - 1) * gapRatio,
  };
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
  const { widthUnits, heightUnits } = compositionUnits(
    cols,
    rows,
    useGap ? gapRatio : 0,
  );
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

import {
  MAX_GRID_COLS,
  MAX_GRID_ROWS,
  tileRects,
} from './grid.js';

export const MAX_TILES = MAX_GRID_COLS * MAX_GRID_ROWS;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toPixelRect(rect, imageWidth, imageHeight) {
  const left = clamp(Math.round(rect.x * imageWidth), 0, imageWidth - 1);
  const top = clamp(Math.round(rect.y * imageHeight), 0, imageHeight - 1);
  const right = clamp(
    Math.round((rect.x + rect.width) * imageWidth),
    left + 1,
    imageWidth,
  );
  const bottom = clamp(
    Math.round((rect.y + rect.height) * imageHeight),
    top + 1,
    imageHeight,
  );
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

export function buildTileSpecs(recipe, sourceImage) {
  const { width: sourceWidth, height: sourceHeight } = sourceImage;
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    throw new Error('原图片尺寸无效');
  }

  const source = toPixelRect(
    recipe.transport.contentRect,
    sourceWidth,
    sourceHeight,
  );
  const actualAspect = source.width / source.height;
  const expectedAspect = recipe.source.width / recipe.source.height;
  if (Math.abs(actualAspect / expectedAspect - 1) > 0.02) {
    throw new Error(
      `原图区域宽高比异常：实际 ${source.width}×${source.height}，参数 ${recipe.source.width}×${recipe.source.height}`,
    );
  }

  const normalizedTiles = tileRects(
    recipe.crop,
    recipe.grid.cols,
    recipe.grid.rows,
    recipe.mode,
    recipe.gapRatio,
  );
  if (normalizedTiles.length > MAX_TILES) {
    throw new Error(`切片数超过 ${MAX_TILES} 张上限`);
  }

  return normalizedTiles.map((tile, index) => {
    const relative = toPixelRect(tile, source.width, source.height);
    return {
      index,
      row: tile.row,
      col: tile.col,
      left: source.left + relative.left,
      top: source.top + relative.top,
      width: relative.width,
      height: relative.height,
      // V1 recipes carry a legacy square output size. Preserve source pixels
      // instead: enlarging every crop made small animated tiles enormous.
      outputWidth: relative.width,
      outputHeight: relative.height,
    };
  });
}

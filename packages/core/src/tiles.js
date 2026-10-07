import {
  MAX_GRID_COLS,
  MAX_GRID_ROWS,
  tileRects,
} from './grid.js';

export const MAX_TILES = MAX_GRID_COLS * MAX_GRID_ROWS;
export const MAX_SIGNATURE_TILE_SIZE = 50;
export const MAX_ANIMATED_TILE_RAW_BYTES = 8 * 1024 * 1024;

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

function fitOutputSize(width, height, frames) {
  const frameCount =
    Number.isInteger(frames) && frames > 0 ? frames : 1;
  const maxPixelsPerFrame = Math.max(
    1,
    Math.floor(MAX_ANIMATED_TILE_RAW_BYTES / 4 / frameCount),
  );
  const maxEdgeFromBudget = Math.max(
    1,
    Math.floor(Math.sqrt(maxPixelsPerFrame)),
  );
  const scale = Math.min(
    1,
    Math.min(MAX_SIGNATURE_TILE_SIZE, maxEdgeFromBudget) /
      Math.max(width, height),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
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
    const output = fitOutputSize(
      relative.width,
      relative.height,
      sourceImage.pages,
    );
    return {
      index,
      row: tile.row,
      col: tile.col,
      left: source.left + relative.left,
      top: source.top + relative.top,
      width: relative.width,
      height: relative.height,
      // Signature tiles render at 28 px in Lark. Keep enough source detail for
      // high-DPI clients without uploading the full crop resolution.
      outputWidth: output.width,
      outputHeight: output.height,
    };
  });
}

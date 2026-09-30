import { tileRects } from './grid.js';

export const MAX_TILES = 225;
export const MAX_FRAME_TILE_WORK = 3600;

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

export function buildTileSpecs(recipe, transportImage) {
  const { width: transportWidth, height: transportHeight } = transportImage;
  if (
    !Number.isInteger(transportWidth) ||
    !Number.isInteger(transportHeight) ||
    transportWidth < 1 ||
    transportHeight < 1
  ) {
    throw new Error('传输图片尺寸无效');
  }

  const source = toPixelRect(
    recipe.transport.contentRect,
    transportWidth,
    transportHeight,
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
  if (normalizedTiles.length * recipe.source.frames > MAX_FRAME_TILE_WORK) {
    throw new Error(
      `动图处理量过大：${normalizedTiles.length} 张 × ${recipe.source.frames} 帧，超过 ${MAX_FRAME_TILE_WORK} 上限`,
    );
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
      outputWidth: recipe.output.width,
      outputHeight: recipe.output.height,
    };
  });
}

import sharp from 'sharp';
import {
  decode as decodeGif,
  decodeUndisposedFrame,
} from 'modern-gif';
import { streamApngFrames } from './apng-source.js';

function clearRect(canvas, canvasWidth, rect) {
  for (let row = 0; row < rect.height; row += 1) {
    const start = ((rect.top + row) * canvasWidth + rect.left) * 4;
    canvas.fill(0, start, start + rect.width * 4);
  }
}

function compositePatch(canvas, canvasWidth, frame, patch) {
  for (let row = 0; row < frame.height; row += 1) {
    for (let column = 0; column < frame.width; column += 1) {
      const source = (row * frame.width + column) * 4;
      if (patch[source + 3] === 0) continue;
      const target =
        ((frame.top + row) * canvasWidth + frame.left + column) * 4;
      canvas[target] = patch[source];
      canvas[target + 1] = patch[source + 1];
      canvas[target + 2] = patch[source + 2];
      canvas[target + 3] = patch[source + 3];
    }
  }
}

async function* streamGifFrames(input, sourceImage) {
  const gif = decodeGif(input);
  if (
    gif.width !== sourceImage.width ||
    gif.height !== sourceImage.height ||
    gif.frames.length !== sourceImage.pages
  ) {
    throw new Error('GIF 解码元数据与图片探测结果不一致');
  }
  let canvas = new Uint8ClampedArray(gif.width * gif.height * 4);
  let previousFrame = null;
  let previousRestore = null;

  for (let index = 0; index < gif.frames.length; index += 1) {
    if (previousFrame?.disposal === 2) {
      clearRect(canvas, gif.width, previousFrame);
    } else if (previousFrame?.disposal === 3 && previousRestore) {
      canvas = previousRestore;
    }

    const frame = gif.frames[index];
    const restore = frame.disposal === 3 ? canvas.slice() : null;
    const decoded = decodeUndisposedFrame(input, gif, index);
    compositePatch(canvas, gif.width, frame, decoded.data);
    yield {
      index,
      // The consumer finishes processing each yielded frame before this
      // generator mutates the compositing canvas for the next frame.
      data: canvas,
      delay: Math.max(20, sourceImage.delay?.[index] || decoded.delay || 100),
    };
    previousFrame = frame;
    previousRestore = restore;
  }
}

async function* streamSharpFrames(input, sourceImage) {
  for (let index = 0; index < sourceImage.pages; index += 1) {
    const { data, info } = await sharp(input, {
      page: index,
      pages: 1,
      limitInputPixels: false,
      failOn: 'warning',
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      info.width !== sourceImage.width ||
      info.height !== sourceImage.height ||
      info.channels !== 4
    ) {
      throw new Error(
        `第 ${index + 1} 帧尺寸异常：${info.width}×${info.height}×${info.channels}`,
      );
    }
    yield {
      index,
      data: new Uint8ClampedArray(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ),
      delay: Math.max(20, sourceImage.delay?.[index] || 100),
    };
  }
}

export function streamAnimationFrames(input, sourceImage) {
  if (
    !Number.isInteger(sourceImage.width) ||
    !Number.isInteger(sourceImage.height) ||
    !Number.isInteger(sourceImage.pages) ||
    sourceImage.width < 1 ||
    sourceImage.height < 1 ||
    sourceImage.pages < 2
  ) {
    throw new Error('动图流元数据无效');
  }
  if (sourceImage.format === 'gif') {
    return streamGifFrames(input, sourceImage);
  }
  if (sourceImage.format === 'apng') {
    return streamApngFrames(input, sourceImage);
  }
  return streamSharpFrames(input, sourceImage);
}

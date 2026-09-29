import { decode as decodeGif, decodeFrames, encode as encodeGif } from 'modern-gif';
import UPNG from 'upng-js';

import {
  detectImageKind,
  validateStaticImageSize,
} from './image-format.js';
import { validateAnimationWork } from './transport-core.js';

function clampDelay(value) {
  return Math.max(20, Math.min(65535, Math.round(value || 100)));
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function decodeGifFrames(bytes) {
  const gif = decodeGif(bytes);
  validateStaticImageSize(gif.width, gif.height);
  validateAnimationWork(gif.width, gif.height, gif.frames.length);
  const frames = decodeFrames(bytes, { gif }).map((frame) => ({
    data: frame.data,
    delay: clampDelay(frame.delay),
  }));
  return {
    width: gif.width,
    height: gif.height,
    frames,
    loop: gif.looped === false ? 1 : gif.loopCount ?? 0,
  };
}

function decodeApngFrames(bytes) {
  const image = UPNG.decode(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ));
  validateStaticImageSize(image.width, image.height);
  const rgbaFrames = UPNG.toRGBA8(image);
  validateAnimationWork(image.width, image.height, rgbaFrames.length);
  return {
    width: image.width,
    height: image.height,
    frames: rgbaFrames.map((buffer, index) => ({
      data: new Uint8ClampedArray(buffer),
      delay: clampDelay(image.frames[index]?.delay),
    })),
    loop: image.tabs?.acTL?.num_plays ?? 0,
  };
}

async function decodeWithImageDecoder(bytes, mimeType) {
  if (!globalThis.ImageDecoder) {
    throw new Error('当前浏览器不支持 Animated WebP 解码，请改用 GIF 或 APNG');
  }
  const decoder = new ImageDecoder({ data: bytes, type: mimeType });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const frameCount = track?.frameCount || 1;
  const first = await decoder.decode({ frameIndex: 0 });
  const width = first.image.displayWidth || first.image.codedWidth || 0;
  const height = first.image.displayHeight || first.image.codedHeight || 0;
  validateStaticImageSize(width, height);
  validateAnimationWork(width, height, frameCount);
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const { image } =
      index === 0 ? first : await decoder.decode({ frameIndex: index });
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    frames.push({
      data,
      delay: clampDelay((image.duration || 100000) / 1000),
    });
    image.close();
  }
  decoder.close();
  return { width, height, frames, loop: track?.repetitionCount ?? 0 };
}

async function decodeStaticImage(file) {
  const bitmap = await createImageBitmap(file);
  validateStaticImageSize(bitmap.width, bitmap.height);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return {
    width: canvas.width,
    height: canvas.height,
    frames: [{ data, delay: 100 }],
    loop: 1,
  };
}

export async function decodeImageBytes(bytes, mimeType = '') {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const kind = detectImageKind(source);
  if (kind.format === 'gif') return decodeGifFrames(source);
  if (kind.format === 'apng') return decodeApngFrames(source);
  if (kind.format === 'webp' && kind.animated) {
    return decodeWithImageDecoder(source, mimeType || 'image/webp');
  }
  throw new Error('该内容不是支持的动图');
}

export async function decodeImageFrames(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectImageKind(bytes);
  if (kind.animated) return decodeImageBytes(bytes, file.type);
  return decodeStaticImage(file);
}

export async function encodeGifFrames({
  width,
  height,
  frames,
  loop = 0,
}) {
  validateAnimationWork(width, height, frames.length);
  const output = await encodeGif({
    width,
    height,
    looped: true,
    loopCount: loop,
    frames: frames.map((frame) => ({
      data: frame.data,
      delay: clampDelay(frame.delay),
    })),
    maxColors: 255,
    dither: 'floyd-steinberg',
  });
  return new Blob([output], { type: 'image/gif' });
}

export function frameToCanvas(frame, width, height) {
  const canvas = createCanvas(width, height);
  canvas
    .getContext('2d')
    .putImageData(new ImageData(frame.data, width, height), 0, 0);
  return canvas;
}

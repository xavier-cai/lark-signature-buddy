import { open } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

import { crc32 } from '@lark-signature-buddy/core/recipe';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.allocUnsafe(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(
    crc32(output.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return output;
}

function imageHeader(width, height, colorType) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = colorType;
  return chunk('IHDR', data);
}

function animationControl(frameCount, loop) {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(frameCount, 0);
  data.writeUInt32BE(loop, 4);
  return chunk('acTL', data);
}

function alphaPalette(levels, gamma) {
  const colors = Buffer.allocUnsafe(levels * 3);
  const transparency = Buffer.allocUnsafe(levels);
  for (let index = 0; index < levels; index += 1) {
    const alpha = Math.round((index * 255) / (levels - 1));
    const sourceLuminance = 1 - alpha / 255;
    const luminance = Math.round(255 * (sourceLuminance ** gamma));
    colors[index * 3] = luminance;
    colors[index * 3 + 1] = luminance;
    colors[index * 3 + 2] = luminance;
    transparency[index] = alpha;
  }
  return [chunk('PLTE', colors), chunk('tRNS', transparency)];
}

function frameControl(sequence, rect, delay) {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(rect.width, 4);
  data.writeUInt32BE(rect.height, 8);
  data.writeUInt32BE(rect.x, 12);
  data.writeUInt32BE(rect.y, 16);
  data.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(delay))), 20);
  data.writeUInt16BE(1000, 22);
  data[24] = 0;
  data[25] = 0;
  return chunk('fcTL', data);
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function filteredRow(row, previous, bytesPerPixel, type) {
  const output = Buffer.allocUnsafe(row.length);
  let score = 0;
  for (let index = 0; index < row.length; index += 1) {
    const value = row[index];
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const above = previous?.[index] ?? 0;
    const upperLeft =
      index >= bytesPerPixel ? previous?.[index - bytesPerPixel] ?? 0 : 0;
    let predictor = 0;
    if (type === 1) predictor = left;
    if (type === 2) predictor = above;
    if (type === 3) predictor = Math.floor((left + above) / 2);
    if (type === 4) predictor = paeth(left, above, upperLeft);
    const filtered = (value - predictor + 256) & 0xff;
    output[index] = filtered;
    score += Math.min(filtered, 256 - filtered);
  }
  return { output, score };
}

function scanlines(pixels, width, height, bytesPerPixel) {
  const rowBytes = width * bytesPerPixel;
  if (pixels.length !== rowBytes * height) {
    throw new Error('APNG 帧像素尺寸不匹配');
  }
  const output = Buffer.allocUnsafe((rowBytes + 1) * height);
  let previous = null;
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (rowBytes + 1);
    const current = Buffer.from(
      pixels.buffer,
      pixels.byteOffset + row * rowBytes,
      rowBytes,
    );
    let best = null;
    for (let type = 0; type <= 4; type += 1) {
      const candidate = filteredRow(
        current,
        previous,
        bytesPerPixel,
        type,
      );
      if (!best || candidate.score < best.score) {
        best = { ...candidate, type };
      }
    }
    output[outputOffset] = best.type;
    best.output.copy(output, outputOffset + 1);
    previous = current;
  }
  return output;
}

function packFrame(rgba, mode, alphaLevels) {
  if (mode === 'rgba') return rgba;
  if (mode === 'indexed-alpha') {
    const output = new Uint8ClampedArray(rgba.length / 4);
    for (
      let sourceIndex = 3, outputIndex = 0;
      sourceIndex < rgba.length;
      sourceIndex += 4, outputIndex += 1
    ) {
      output[outputIndex] = Math.round(
        (rgba[sourceIndex] * (alphaLevels - 1)) / 255,
      );
    }
    return output;
  }
  const output = new Uint8ClampedArray(rgba.length / 2);
  for (
    let sourceIndex = 0, outputIndex = 0;
    sourceIndex < rgba.length;
    sourceIndex += 4, outputIndex += 2
  ) {
    output[outputIndex] = rgba[sourceIndex];
    output[outputIndex + 1] = rgba[sourceIndex + 3];
  }
  return output;
}

function differenceRect(current, previous, width, height, bytesPerPixel) {
  if (!previous) return { x: 0, y: 0, width, height };
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * bytesPerPixel;
      let changed = false;
      for (let channel = 0; channel < bytesPerPixel; channel += 1) {
        if (current[offset + channel] !== previous[offset + channel]) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function extractRect(pixels, canvasWidth, rect, bytesPerPixel) {
  const rowBytes = rect.width * bytesPerPixel;
  const output = new Uint8ClampedArray(rowBytes * rect.height);
  for (let row = 0; row < rect.height; row += 1) {
    const sourceOffset =
      ((rect.y + row) * canvasWidth + rect.x) * bytesPerPixel;
    output.set(
      pixels.subarray(sourceOffset, sourceOffset + rowBytes),
      row * rowBytes,
    );
  }
  return output;
}

export async function writeApngFile({
  path,
  width,
  height,
  frameCount,
  loop = 0,
  grayscaleAlpha = false,
  indexedAlpha = false,
  alphaLevels = 256,
  gamma = 1,
  renderFrame,
}) {
  if (
    indexedAlpha &&
    (!Number.isInteger(alphaLevels) || alphaLevels < 2 || alphaLevels > 256)
  ) {
    throw new Error('APNG alpha 色阶必须是 2–256 的整数');
  }
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 3) {
    throw new Error('APNG gamma 必须在 0–3 之间');
  }
  const file = await open(path, 'w', 0o600);
  let sequence = 0;
  let previous = null;
  const mode = indexedAlpha
    ? 'indexed-alpha'
    : grayscaleAlpha
      ? 'grayscale-alpha'
      : 'rgba';
  const bytesPerPixel = mode === 'rgba' ? 4 : mode === 'grayscale-alpha' ? 2 : 1;
  const colorType = mode === 'rgba' ? 6 : mode === 'grayscale-alpha' ? 4 : 3;
  try {
    await file.write(PNG_SIGNATURE);
    await file.write(imageHeader(width, height, colorType));
    if (mode === 'indexed-alpha') {
      for (const paletteChunk of alphaPalette(alphaLevels, gamma)) {
        await file.write(paletteChunk);
      }
    }
    await file.write(animationControl(frameCount, loop));
    for (let index = 0; index < frameCount; index += 1) {
      const frame = await renderFrame(index);
      const pixels = packFrame(frame.data, mode, alphaLevels);
      const rect = differenceRect(
        pixels,
        previous,
        width,
        height,
        bytesPerPixel,
      );
      const rectPixels = extractRect(
        pixels,
        width,
        rect,
        bytesPerPixel,
      );
      await file.write(
        frameControl(sequence, rect, frame.delay),
      );
      sequence += 1;
      const compressed = deflateSync(
        scanlines(
          rectPixels,
          rect.width,
          rect.height,
          bytesPerPixel,
        ),
        { level: 9 },
      );
      if (index === 0) {
        await file.write(chunk('IDAT', compressed));
      } else {
        const data = Buffer.allocUnsafe(compressed.length + 4);
        data.writeUInt32BE(sequence, 0);
        compressed.copy(data, 4);
        await file.write(chunk('fdAT', data));
        sequence += 1;
      }
      previous = pixels;
    }
    await file.write(chunk('IEND', Buffer.alloc(0)));
  } finally {
    await file.close();
  }
}

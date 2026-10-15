import sharp from 'sharp';

import { crc32 } from '@lark-signature-buddy/core/recipe';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngChunk(type, data) {
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

function parseChunks(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error('APNG 文件头无效');
  }
  const chunks = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('APNG chunk 长度越界');
    chunks.push({
      type: bytes.toString('ascii', offset + 4, offset + 8),
      data: bytes.subarray(offset + 8, offset + 8 + length),
    });
    offset = end;
  }
  return chunks;
}

function frameControl(data) {
  if (data.length !== 26) throw new Error('APNG fcTL 长度无效');
  const delayDenominator = data.readUInt16BE(22) || 100;
  return {
    width: data.readUInt32BE(4),
    height: data.readUInt32BE(8),
    x: data.readUInt32BE(12),
    y: data.readUInt32BE(16),
    delay: Math.max(
      20,
      Math.round((data.readUInt16BE(20) * 1000) / delayDenominator),
    ),
    dispose: data[24],
    blend: data[25],
    parts: [],
  };
}

export function parseApng(input) {
  const chunks = parseChunks(input);
  const ihdr = chunks.find((entry) => entry.type === 'IHDR');
  const control = chunks.find((entry) => entry.type === 'acTL');
  if (!ihdr || ihdr.data.length !== 13 || !control || control.data.length !== 8) {
    throw new Error('APNG 缺少 IHDR 或 acTL');
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const expectedFrames = control.data.readUInt32BE(0);
  const loop = control.data.readUInt32BE(4);
  const sharedChunks = chunks.filter((entry) =>
    !['IHDR', 'acTL', 'fcTL', 'IDAT', 'fdAT', 'IEND'].includes(entry.type));
  const frames = [];
  let current = null;
  for (const entry of chunks) {
    if (entry.type === 'fcTL') {
      current = frameControl(entry.data);
      frames.push(current);
    } else if (entry.type === 'IDAT') {
      // APNG may carry a default still image before the first fcTL. It is not
      // part of the animation and can be ignored for frame streaming.
      if (current) current.parts.push(entry.data);
    } else if (entry.type === 'fdAT') {
      if (!current || entry.data.length < 4) {
        throw new Error('APNG fdAT 缺少对应帧');
      }
      current.parts.push(entry.data.subarray(4));
    }
  }
  if (frames.length !== expectedFrames || frames.some((frame) =>
    frame.width < 1 ||
    frame.height < 1 ||
    frame.x + frame.width > width ||
    frame.y + frame.height > height ||
    frame.parts.length === 0 ||
    frame.dispose > 2 ||
    frame.blend > 1)) {
    throw new Error('APNG 帧控制信息无效');
  }
  return {
    width,
    height,
    pages: frames.length,
    delay: frames.map((frame) => frame.delay),
    loop,
    frames,
    ihdr: ihdr.data,
    sharedChunks,
  };
}

function standaloneFramePng(animation, frame) {
  const header = Buffer.from(animation.ihdr);
  header.writeUInt32BE(frame.width, 0);
  header.writeUInt32BE(frame.height, 4);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    ...animation.sharedChunks.map((entry) => pngChunk(entry.type, entry.data)),
    ...frame.parts.map((part) => pngChunk('IDAT', part)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clearRect(canvas, canvasWidth, frame) {
  for (let row = 0; row < frame.height; row += 1) {
    const start = ((frame.y + row) * canvasWidth + frame.x) * 4;
    canvas.fill(0, start, start + frame.width * 4);
  }
}

function blendPatch(canvas, canvasWidth, frame, patch) {
  for (let row = 0; row < frame.height; row += 1) {
    for (let column = 0; column < frame.width; column += 1) {
      const source = (row * frame.width + column) * 4;
      const target =
        ((frame.y + row) * canvasWidth + frame.x + column) * 4;
      if (frame.blend === 0) {
        canvas.set(patch.subarray(source, source + 4), target);
        continue;
      }
      const sourceAlpha = patch[source + 3] / 255;
      const targetAlpha = canvas[target + 3] / 255;
      const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      if (outputAlpha === 0) {
        canvas.fill(0, target, target + 4);
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        canvas[target + channel] = Math.round(
          (
            patch[source + channel] * sourceAlpha +
            canvas[target + channel] * targetAlpha * (1 - sourceAlpha)
          ) / outputAlpha,
        );
      }
      canvas[target + 3] = Math.round(outputAlpha * 255);
    }
  }
}

export async function* streamApngFrames(input, sourceImage) {
  const animation = parseApng(input);
  if (
    animation.width !== sourceImage.width ||
    animation.height !== sourceImage.height ||
    animation.pages !== sourceImage.pages
  ) {
    throw new Error('APNG 解码元数据与图片探测结果不一致');
  }
  let canvas = new Uint8ClampedArray(
    animation.width * animation.height * 4,
  );
  let previousFrame = null;
  let previousRestore = null;
  for (let index = 0; index < animation.frames.length; index += 1) {
    if (previousFrame?.dispose === 1) {
      clearRect(canvas, animation.width, previousFrame);
    } else if (previousFrame?.dispose === 2 && previousRestore) {
      canvas = previousRestore;
    }
    const frame = animation.frames[index];
    const restore = frame.dispose === 2 ? canvas.slice() : null;
    const { data } = await sharp(standaloneFramePng(animation, frame))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    blendPatch(canvas, animation.width, frame, data);
    yield {
      index,
      data: canvas,
      delay: frame.delay,
    };
    previousFrame = frame;
    previousRestore = restore;
  }
}

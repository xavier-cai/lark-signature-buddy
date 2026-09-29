import { crc32 } from './image-recipe.js';

export const PNG_RECIPE_KEYWORD = 'ImageBuddy';
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('latin1');

function bytesEqual(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function uint32Bytes(value) {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function readUint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function chunk(type, data) {
  const typeBytes = textEncoder.encode(type);
  const checksum = crc32(concatBytes([typeBytes, data]));
  return concatBytes([
    uint32Bytes(data.length),
    typeBytes,
    data,
    uint32Bytes(checksum),
  ]);
}

function assertPng(bytes) {
  if (!bytesEqual(bytes.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE)) {
    throw new Error('图片不是 PNG 格式');
  }
}

export function embedRecipeInPng(input, token) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  assertPng(bytes);
  const keyword = textEncoder.encode(PNG_RECIPE_KEYWORD);
  const value = textEncoder.encode(token);
  const metadataChunk = chunk('tEXt', concatBytes([keyword, Uint8Array.of(0), value]));
  let offset = PNG_SIGNATURE.length;
  const parts = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let inserted = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG chunk 长度无效');
    const type = textDecoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (type === 'IEND' && !inserted) {
      parts.push(metadataChunk);
      inserted = true;
    }
    parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (!inserted || offset !== bytes.length) throw new Error('PNG 缺少有效 IEND');
  return concatBytes(parts);
}

export function extractRecipeFromPng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  assertPng(bytes);
  let offset = PNG_SIGNATURE.length;
  const values = [];
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > bytes.length) throw new Error('PNG chunk 长度无效');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = readUint32(bytes, dataEnd);
    if (crc32(concatBytes([typeBytes, data])) !== expectedCrc) {
      throw new Error('PNG chunk CRC32 校验失败');
    }
    const type = textDecoder.decode(typeBytes);
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = textDecoder.decode(data.subarray(0, separator));
        if (keyword === PNG_RECIPE_KEYWORD) {
          values.push(textDecoder.decode(data.subarray(separator + 1)));
        }
      }
    }
    offset = end;
    if (type === 'IEND') break;
  }
  if (values.length === 0) throw new Error('PNG 内未找到 ImageBuddy V1 参数');
  if (values.length !== 1) throw new Error(`PNG 内存在 ${values.length} 份 ImageBuddy 参数`);
  return values[0];
}

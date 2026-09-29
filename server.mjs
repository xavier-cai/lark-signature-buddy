import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PORT = Number.parseInt(process.env.IMAGE_BUDDY_PORT || '32180', 10);
const HOST = process.env.IMAGE_BUDDY_HOST || '0.0.0.0';
const PROFILE = process.env.IMAGE_BUDDY_PROFILE || 'image-buddy';
const TLS_CERT_FILE = process.env.IMAGE_BUDDY_TLS_CERT || '';
const TLS_KEY_FILE = process.env.IMAGE_BUDDY_TLS_KEY || '';
const ACCESS_TOKEN = process.env.IMAGE_BUDDY_ACCESS_TOKEN || randomBytes(24).toString('base64url');
const TOKEN_HASH = createHash('sha256').update(ACCESS_TOKEN).digest();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestBuckets = new Map();

function json(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "frame-ancestors https://*.larkoffice.com https://*.feishu.cn",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function tokenMatches(candidate = '') {
  const digest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(TOKEN_HASH, digest);
}

function getToken(requestUrl, request) {
  const urlToken = requestUrl.searchParams.get('token') || '';
  const header = request.headers.authorization || '';
  const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  return urlToken || bearerToken;
}

function allowedByRateLimit(address) {
  const now = Date.now();
  const bucket = requestBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    requestBuckets.set(address, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= MAX_REQUESTS_PER_WINDOW;
}

function detectImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return 'image/bmp';
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x00010000) {
    return 'image/x-icon';
  }
  if (
    buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ) {
    return 'image/tiff';
  }
  const boxType = buffer.subarray(4, 12).toString('ascii');
  if (boxType.startsWith('ftyp') && /hei[cf]|mif1/.test(buffer.subarray(8, 32).toString('ascii'))) {
    return 'image/heic';
  }
  return null;
}

async function readBody(request) {
  const contentLength = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('图片不能超过 10 MB'), { statusCode: 413 });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error('图片不能超过 10 MB'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw Object.assign(new Error('请选择非空图片'), { statusCode: 400 });
  }
  return Buffer.concat(chunks);
}

function uploadToLark(image) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'lark-cli',
      [
        'api',
        'POST',
        '/open-apis/im/v1/images',
        '--profile',
        PROFILE,
        '--as',
        'bot',
        '--data',
        '{"image_type":"message"}',
        '--file',
        'image=-',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        },
      },
    );

    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        reject(new Error(diagnostic || output || `lark-cli exited with ${code}`));
        return;
      }
      const imageKey = parsed?.data?.image_key;
      if (code === 0 && parsed?.ok === true && typeof imageKey === 'string') {
        resolve(imageKey);
        return;
      }
      reject(new Error(parsed?.error?.message || diagnostic || '飞书上传失败'));
    });
    child.stdin.end(image);
  });
}

async function serveAsset(response, name, contentType) {
  const body = await readFile(join(ROOT, 'public', name));
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': body.length,
  });
  response.end(body);
}

async function handleRequest(request, response) {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/healthz') {
      json(response, 200, { ok: true, profile: PROFILE });
      return;
    }

    if (
      request.method === 'GET' &&
      ['/app.js', '/styles.css'].includes(requestUrl.pathname)
    ) {
      const isScript = requestUrl.pathname === '/app.js';
      await serveAsset(
        response,
        isScript ? 'app.js' : 'styles.css',
        isScript ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      );
      return;
    }

    if (request.method === 'OPTIONS' && requestUrl.pathname === '/api/upload') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }

    if (!tokenMatches(getToken(requestUrl, request))) {
      json(response, 401, { ok: false, message: '访问链接无效或已过期' });
      return;
    }

    const address = request.socket.remoteAddress || 'unknown';
    if (!allowedByRateLimit(address)) {
      json(response, 429, { ok: false, message: '请求过于频繁，请稍后重试' });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      await serveAsset(response, 'index.html', 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/upload') {
      const image = await readBody(request);
      const imageType = detectImage(image);
      if (!imageType) {
        json(response, 415, {
          ok: false,
          message: '不支持该文件；请上传 JPG、PNG、WEBP、GIF、BMP、ICO、TIFF 或 HEIC',
        });
        return;
      }
      const imageKey = await uploadToLark(image);
      json(response, 200, { ok: true, imageKey, imageType, size: image.length });
      return;
    }

    json(response, 404, { ok: false, message: 'Not found' });
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    json(response, statusCode, {
      ok: false,
      message: statusCode === 500 ? `上传失败：${error.message}` : error.message,
    });
  }
}

const modulePath = realpathSync(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : '';

if (modulePath === entryPath) {
  const useTls = Boolean(TLS_CERT_FILE && TLS_KEY_FILE);
  const server = useTls
    ? createSecureServer(
        {
          cert: await readFile(TLS_CERT_FILE),
          key: await readFile(TLS_KEY_FILE),
        },
        handleRequest,
      )
    : createServer(handleRequest);

  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? process.env.MY_HOST_IP || '127.0.0.1' : HOST;
    const scheme = useTls ? 'https' : 'http';
    console.log(`IMAGE_BUDDY_URL=${scheme}://${shownHost}:${PORT}/?token=${ACCESS_TOKEN}`);
    console.log(`IMAGE_BUDDY_HEALTH=${scheme}://${shownHost}:${PORT}/healthz`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { detectImage };

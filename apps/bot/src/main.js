import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

import {
  eventBatchKey,
  extractImageKeys,
  formatGeneratedReply,
} from './messages.js';
import {
  decodeRecipeFromImage,
  downloadMessageImage,
} from './image.js';
import { SerialQueue } from './serial-queue.js';
import { generateAndUploadTiles } from './tiles.js';

const PROFILE =
  process.env.LARK_SIGNATURE_BUDDY_PROFILE || 'lark-signature-buddy';
const DEBOUNCE_MS = Number.parseInt(
  process.env.LARK_SIGNATURE_BUDDY_BATCH_DELAY_MS || '1500',
  10,
);
const MAX_BATCH_MS = Number.parseInt(
  process.env.LARK_SIGNATURE_BUDDY_MAX_BATCH_MS || '5000',
  10,
);
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const batches = new Map();
const seenMessages = new Map();
const processingQueue = new SerialQueue();
let shuttingDown = false;

function log(level, message, detail = {}) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...detail })}\n`);
}

function runLark(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(diagnostic || output || `lark-cli exited with ${code}`));
        return;
      }
      try {
        resolve(output ? JSON.parse(output) : {});
      } catch {
        resolve({ output });
      }
    });
  });
}

function idempotencyKey(messageIds) {
  return `lsb_${createHash('sha256').update(messageIds.join(',')).digest('hex').slice(0, 32)}`;
}

function userFacingDecodeError(error) {
  if (
    error.message.includes('99991672') ||
    error.message.includes('im:message:readonly')
  ) {
    return '图片仔应用缺少 im:message:readonly 权限，暂时无法下载图片进行扫码。';
  }
  if (
    error.message.includes('im:resource') ||
    error.message.includes('im:resource:upload')
  ) {
    return '图片仔应用缺少 im:resource 权限，暂时无法上传切片。';
  }
  return error.message;
}

async function processBatch(batch) {
  const keys = [...new Set(batch.imageKeys)];
  let text;
  if (batch.errors.length > 0) {
    text = `切图请求读取失败：${batch.errors[0]}`;
  } else if (batch.images.length !== 1) {
    text = `切图请求无效：期望 1 张传输图，收到 ${batch.images.length} 张。`;
  } else {
    const image = batch.images[0];
    try {
      const input = await downloadMessageImage({
        messageId: image.messageId,
        imageKey: image.imageKey,
        profile: PROFILE,
        runLark,
      });
      const decoded = await decodeRecipeFromImage(input);
      log('info', 'decoded signature recipe', {
        messageId: image.messageId,
        imageKey: image.imageKey,
        transportWidth: decoded.image.width,
        transportHeight: decoded.image.height,
        tokenLength: decoded.token.length,
        cols: decoded.recipe.grid.cols,
        rows: decoded.recipe.grid.rows,
      });
      const generatedKeys = await generateAndUploadTiles({
        input,
        recipe: decoded.recipe,
        transportImage: decoded.image,
        profile: PROFILE,
        runLark,
      });
      log('info', 'generated and uploaded signature tiles', {
        messageId: image.messageId,
        sourceImageKey: image.imageKey,
        imageCount: generatedKeys.length,
      });
      text = formatGeneratedReply(generatedKeys, decoded.recipe);
    } catch (error) {
      log('warn', 'failed to process signature recipe', {
        messageId: image.messageId,
        imageKey: image.imageKey,
        error: error.message,
      });
      text = `切图请求读取失败：${userFacingDecodeError(error)}`;
    }
  }
  try {
    await runLark([
      'im',
      '+messages-reply',
      '--profile',
      PROFILE,
      '--as',
      'bot',
      '--message-id',
      batch.replyMessageId,
      '--text',
      text,
      '--idempotency-key',
      idempotencyKey(batch.messageIds),
      '--json',
    ]);
    log('info', 'replied with image keys', {
      messageId: batch.replyMessageId,
      imageCount: keys.length,
    });
  } catch (error) {
    log('error', 'failed to reply with image keys', {
      messageId: batch.replyMessageId,
      error: error.message,
    });
  }
}

function replyToBatch(batchKey) {
  const batch = batches.get(batchKey);
  if (!batch) return Promise.resolve();
  clearTimeout(batch.timer);
  batches.delete(batchKey);
  return processingQueue.run(batchKey, () => processBatch(batch));
}

function scheduleBatch(event, { imageKeys = [], error = null }) {
  const key = eventBatchKey(event);
  const now = Date.now();
  const existing = batches.get(key);
  const batch = existing || {
    imageKeys: [],
    images: [],
    errors: [],
    messageIds: [],
    replyMessageId: event.message_id,
    firstAt: now,
    timer: null,
  };
  batch.imageKeys.push(...imageKeys);
  batch.images.push(
    ...imageKeys.map((imageKey) => ({
      imageKey,
      messageId: event.message_id,
    })),
  );
  if (error) batch.errors.push(error);
  batch.messageIds.push(event.message_id);
  batch.replyMessageId = event.message_id;
  if (batch.timer) clearTimeout(batch.timer);
  const remaining = Math.max(0, MAX_BATCH_MS - (now - batch.firstAt));
  batch.timer = setTimeout(() => replyToBatch(key), Math.min(DEBOUNCE_MS, remaining));
  batches.set(key, batch);
}

function cleanupSeen() {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [messageId, seenAt] of seenMessages) {
    if (seenAt < cutoff) seenMessages.delete(messageId);
  }
}

function handleEvent(event) {
  if (shuttingDown) return;
  if (!event || event.type !== 'im.message.receive_v1') return;
  if (event.sender_type === 'bot') return;
  if (!event.message_id || seenMessages.has(event.message_id)) return;
  seenMessages.set(event.message_id, Date.now());
  if (seenMessages.size > 5000) cleanupSeen();
  const imageKeys = extractImageKeys(event.content);
  if (imageKeys.length === 0) return;
  scheduleBatch(event, { imageKeys });
}

const consumer = spawn(
  'lark-cli',
  [
    'event',
    'consume',
    'im.message.receive_v1',
    '--profile',
    PROFILE,
    '--as',
    'bot',
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

createInterface({ input: consumer.stdout }).on('line', (line) => {
  try {
    handleEvent(JSON.parse(line));
  } catch (error) {
    log('warn', 'ignored malformed event line', { error: error.message });
  }
});

createInterface({ input: consumer.stderr }).on('line', (line) => {
  log(line.includes('[event] ready') ? 'info' : 'debug', line);
});

consumer.once('error', (error) => {
  log('error', 'event consumer failed to start', { error: error.message });
  process.exitCode = 1;
});

consumer.once('close', (code) => {
  if (!shuttingDown) {
    log('error', 'event consumer exited', { code });
    process.exit(code || 1);
  }
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'stopping lark signature buddy bot', { signal });
  const pending = [...batches.keys()].map((key) => replyToBatch(key));
  consumer.kill('SIGTERM');
  await Promise.allSettled(pending);
  await processingQueue.drain();
  process.exitCode = 0;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

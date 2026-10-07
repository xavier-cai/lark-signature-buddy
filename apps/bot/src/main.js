import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

import { decodeSignatureRecipe } from '@lark-signature-buddy/core/recipe';

import {
  eventBatchKey,
  extractImageKeys,
  extractRecipeTokens,
  formatGeneratedReply,
} from './messages.js';
import {
  downloadMessageImage,
  inspectSourceImage,
  prepareDownloadStaging,
} from './image.js';
import { mergeRequestState } from './request-state.js';
import { SerialQueue } from './serial-queue.js';
import {
  generateAndUploadTiles,
  prepareUploadStaging,
} from './tiles.js';

const PROFILE =
  process.env.LARK_SIGNATURE_BUDDY_PROFILE || 'lark-signature-buddy';
const LARK_CLI =
  process.env.LARK_SIGNATURE_BUDDY_LARK_CLI || 'lark-cli';
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = Number.parseInt(
  process.env.LARK_SIGNATURE_BUDDY_REQUEST_TTL_MS || '600000',
  10,
);
const requestStates = new Map();
const seenMessages = new Map();
const eventQueue = new SerialQueue();
const processingQueue = new SerialQueue();
let shuttingDown = false;

await Promise.all([
  prepareDownloadStaging(),
  prepareUploadStaging(),
]);

function log(level, message, detail = {}) {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, message, ...detail })}\n`,
  );
}

function runLark(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(LARK_CLI, args, {
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

function idempotencyKey(messageId, phase) {
  const digest = createHash('sha256')
    .update(`${messageId}:${phase}`)
    .digest('hex')
    .slice(0, 32);
  return `lsb_${digest}`;
}

async function reply(messageId, text, phase, format = 'text') {
  try {
    await runLark([
      'im',
      '+messages-reply',
      '--profile',
      PROFILE,
      '--as',
      'bot',
      '--message-id',
      messageId,
      format === 'markdown' ? '--markdown' : '--text',
      text,
      '--idempotency-key',
      idempotencyKey(messageId, phase),
      '--json',
    ]);
  } catch (error) {
    log('error', 'failed to reply', {
      messageId,
      phase,
      error: error.message,
    });
  }
}

function userFacingError(error) {
  if (
    error.message.includes('99991672') ||
    error.message.includes('im:message:readonly')
  ) {
    return '图片仔应用缺少 im:message:readonly 权限，暂时无法下载图片。';
  }
  if (
    error.message.includes('im:resource') ||
    error.message.includes('im:resource:upload')
  ) {
    return '图片仔应用缺少 im:resource 权限，暂时无法上传切片。';
  }
  return error.message;
}

async function processRequest(request, replyMessageId) {
  try {
    const recipe = decodeSignatureRecipe(request.recipeToken);
    const input = await downloadMessageImage({
      messageId: request.image.messageId,
      imageKey: request.image.imageKey,
      profile: PROFILE,
      runLark,
    });
    const sourceImage = await inspectSourceImage(input, recipe);
    log('info', 'validated source image and recipe', {
      messageId: request.image.messageId,
      imageKey: request.image.imageKey,
      width: sourceImage.width,
      height: sourceImage.height,
      frames: sourceImage.pages,
      cols: recipe.grid.cols,
      rows: recipe.grid.rows,
    });
    const generatedKeys = await generateAndUploadTiles({
      input,
      recipe,
      sourceImage,
      profile: PROFILE,
      runLark,
    });
    await reply(
      replyMessageId,
      formatGeneratedReply(generatedKeys, recipe),
      'result',
      'markdown',
    );
  } catch (error) {
    log('warn', 'failed to process source image and recipe', {
      messageId: replyMessageId,
      error: error.message,
    });
    await reply(
      replyMessageId,
      `切图处理失败：${userFacingError(error)}`,
      'result',
    );
  }
}

function activeState(key, now) {
  const state = requestStates.get(key);
  if (!state) return {};
  if (now - state.updatedAt > REQUEST_TTL_MS) {
    requestStates.delete(key);
    return {};
  }
  return state;
}

async function handleEvent(event) {
  if (shuttingDown) return;
  if (!event || event.type !== 'im.message.receive_v1') return;
  if (event.sender_type === 'bot') return;
  if (!event.message_id || seenMessages.has(event.message_id)) return;
  seenMessages.set(event.message_id, Date.now());
  if (seenMessages.size > 5000) cleanupSeen();

  const key = eventBatchKey(event);
  await eventQueue.run(key, async () => {
    const now = Date.now();
    const transition = mergeRequestState(activeState(key, now), {
      imageKeys: extractImageKeys(event.content),
      recipeTokens: extractRecipeTokens(event.content),
      messageId: event.message_id,
      now,
    });
    if (transition.state) {
      requestStates.set(key, transition.state);
    } else if (transition.status === 'ready') {
      requestStates.delete(key);
    }
    await reply(
      event.message_id,
      transition.message,
      transition.status,
    );
    if (transition.status === 'ready') {
      void processingQueue.run(
        key,
        () => processRequest(transition.request, event.message_id),
      );
    }
  });
}

function cleanupSeen() {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [messageId, seenAt] of seenMessages) {
    if (seenAt < cutoff) seenMessages.delete(messageId);
  }
}

const consumer = spawn(
  LARK_CLI,
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
    void handleEvent(JSON.parse(line)).catch((error) => {
      log('error', 'failed to handle event', { error: error.message });
    });
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
  consumer.kill('SIGTERM');
  await eventQueue.drain();
  await processingQueue.drain();
  process.exitCode = 0;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

import { eventBatchKey, extractImageKeys, formatReply } from './bot-core.mjs';

const PROFILE = process.env.IMAGE_BUDDY_PROFILE || 'image-buddy';
const DEBOUNCE_MS = Number.parseInt(process.env.IMAGE_BUDDY_BATCH_DELAY_MS || '1500', 10);
const MAX_BATCH_MS = Number.parseInt(process.env.IMAGE_BUDDY_MAX_BATCH_MS || '5000', 10);
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const batches = new Map();
const seenMessages = new Map();
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
  return `ib_${createHash('sha256').update(messageIds.join(',')).digest('hex').slice(0, 32)}`;
}

async function replyToBatch(batchKey) {
  const batch = batches.get(batchKey);
  if (!batch) return;
  clearTimeout(batch.timer);
  batches.delete(batchKey);
  if (batch.imageKeys.length === 0) return;

  const keys = [...new Set(batch.imageKeys)];
  const text = formatReply(keys);
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

function scheduleBatch(event, imageKeys) {
  const key = eventBatchKey(event);
  const now = Date.now();
  const existing = batches.get(key);
  const batch = existing || {
    imageKeys: [],
    messageIds: [],
    replyMessageId: event.message_id,
    firstAt: now,
    timer: null,
  };
  batch.imageKeys.push(...imageKeys);
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
  if (!event || event.type !== 'im.message.receive_v1') return;
  if (event.sender_type === 'bot') return;
  if (!event.message_id || seenMessages.has(event.message_id)) return;
  seenMessages.set(event.message_id, Date.now());
  if (seenMessages.size > 5000) cleanupSeen();
  const imageKeys = extractImageKeys(event.content);
  if (imageKeys.length === 0) return;
  scheduleBatch(event, imageKeys);
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

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'stopping image buddy bot', { signal });
  for (const key of [...batches.keys()]) {
    void replyToBatch(key);
  }
  consumer.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


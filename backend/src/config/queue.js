const Queue = require('bull');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || null,
  db: Number(process.env.REDIS_DB || 0)
};

function parseTimeoutMs(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const DEFAULT_QUEUE_TIMEOUT_MS = 30 * 60 * 1000;
const baseQueueTimeoutMs = parseTimeoutMs(process.env.QUEUE_TIMEOUT_MS, DEFAULT_QUEUE_TIMEOUT_MS);
const kbIngestTimeoutMs = parseTimeoutMs(
  process.env.KB_INGEST_QUEUE_TIMEOUT_MS || process.env.KB_QUEUE_TIMEOUT_MS,
  baseQueueTimeoutMs
);
const kbPurgeTimeoutMs = parseTimeoutMs(
  process.env.KB_PURGE_QUEUE_TIMEOUT_MS,
  baseQueueTimeoutMs
);

const queueOptions = {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: Number(process.env.QUEUE_MAX_ATTEMPTS || 3),
    backoff: {
      type: 'exponential',
      delay: Number(process.env.QUEUE_BACKOFF_DELAY || 2000)
    },
    removeOnComplete: Number(process.env.QUEUE_REMOVE_ON_COMPLETE || 100),
    removeOnFail: Number(process.env.QUEUE_REMOVE_ON_FAIL || 100),
    timeout: baseQueueTimeoutMs
  }
};

const kbIngestQueue = new Queue('kb-ingest', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    priority: Number(process.env.KB_QUEUE_PRIORITY || 5),
    timeout: kbIngestTimeoutMs
  }
});

const kbPurgeQueue = new Queue('kb-purge', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    priority: Number(process.env.KB_PURGE_QUEUE_PRIORITY || 4),
    timeout: kbPurgeTimeoutMs
  }
});

kbIngestQueue.on('error', (error) => {
  console.error('[KB队列] 队列错误:', error.message);
});

kbIngestQueue.on('failed', (job, err) => {
  console.error(`[KB队列] 任务失败: ${job?.id}`, err?.message || err);
});

kbIngestQueue.on('completed', (job) => {
  console.log(`[KB队列] 任务完成: ${job.id}`);
});

kbPurgeQueue.on('error', (error) => {
  console.error('[KB回收站队列] 队列错误:', error.message);
});

kbPurgeQueue.on('failed', (job, err) => {
  console.error(`[KB回收站队列] 任务失败: ${job?.id}`, err?.message || err);
});

kbPurgeQueue.on('completed', (job) => {
  console.log(`[KB回收站队列] 任务完成: ${job.id}`);
});

module.exports = {
  redisConfig,
  queueOptions,
  kbIngestQueue,
  kbPurgeQueue
};

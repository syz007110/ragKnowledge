const Queue = require('bull');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || null,
  db: Number(process.env.REDIS_DB || 0)
};

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
    timeout: Number(process.env.QUEUE_TIMEOUT_MS || 600000)
  }
};

const kbIngestQueue = new Queue('kb-ingest', {
  ...queueOptions,
  defaultJobOptions: {
    ...queueOptions.defaultJobOptions,
    priority: Number(process.env.KB_QUEUE_PRIORITY || 5),
    timeout: Number(process.env.KB_QUEUE_TIMEOUT_MS || 600000)
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

module.exports = {
  redisConfig,
  queueOptions,
  kbIngestQueue
};

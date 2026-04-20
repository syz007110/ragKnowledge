const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { kbIngestQueue, kbPurgeQueue } = require('../config/queue');
const { processKbIngestJob } = require('./kbIngestProcessor');
const { processKbPurgeJob } = require('./kbPurgeProcessor');
const { enqueueExpiredRecyclePurgeJobs, purgeExpiredDoneKbJobs } = require('../services/kbService');

const KB_INGEST_CONCURRENCY = Number(process.env.KB_QUEUE_CONCURRENCY || 2);

console.log(`[队列系统] 启动知识库入库队列，并发数: ${KB_INGEST_CONCURRENCY}`);

kbIngestQueue.process('ingest-kb', KB_INGEST_CONCURRENCY, async (job) => {
  try {
    return await processKbIngestJob(job);
  } catch (error) {
    console.error(`[KB队列处理器] 入库任务 ${job.id} 失败:`, error.message);
    throw error;
  }
});

kbPurgeQueue.process('purge-kb', Number(process.env.KB_PURGE_QUEUE_CONCURRENCY || 2), async (job) => {
  try {
    return await processKbPurgeJob(job);
  } catch (error) {
    console.error(`[KB回收站队列处理器] 任务 ${job.id} 失败:`, error.message);
    throw error;
  }
});

kbIngestQueue.on('waiting', (jobId) => {
  console.log(`[KB队列] 任务 ${jobId} 等待处理`);
});

kbIngestQueue.on('active', (job) => {
  console.log(`[KB队列] 任务 ${job.id} 开始处理`);
});

kbIngestQueue.on('completed', (job) => {
  console.log(`[KB队列] 任务 ${job.id} 完成`);
});

kbIngestQueue.on('failed', (job, err) => {
  console.error(`[KB队列] 任务 ${job?.id} 失败:`, err?.message || err);
});

kbPurgeQueue.on('waiting', (jobId) => {
  console.log(`[KB回收站队列] 任务 ${jobId} 等待处理`);
});

kbPurgeQueue.on('active', (job) => {
  console.log(`[KB回收站队列] 任务 ${job.id} 开始处理`);
});

kbPurgeQueue.on('completed', (job) => {
  console.log(`[KB回收站队列] 任务 ${job.id} 完成`);
});

kbPurgeQueue.on('failed', (job, err) => {
  console.error(`[KB回收站队列] 任务 ${job?.id} 失败:`, err?.message || err);
});

function parseRecycleAutoPurgeIntervalMs() {
  const raw = Number.parseInt(String(process.env.KB_RECYCLE_AUTO_PURGE_INTERVAL_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 60000) {
    return raw;
  }
  return 24 * 60 * 60 * 1000;
}

function parseRecycleAutoPurgeInitialDelayMs() {
  const raw = Number.parseInt(String(process.env.KB_RECYCLE_AUTO_PURGE_INITIAL_DELAY_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return 120000;
}

if (String(process.env.KB_RECYCLE_AUTO_PURGE_ENABLED || 'true').toLowerCase() !== 'false') {
  const intervalMs = parseRecycleAutoPurgeIntervalMs();
  const locale = String(process.env.DEFAULT_LOCALE || 'zh-CN').trim() || 'zh-CN';
  const runExpiredRecyclePurge = () => {
    enqueueExpiredRecyclePurgeJobs({ locale, operatorId: null })
      .then((created) => {
        if (Array.isArray(created) && created.length) {
          console.log(`[KB回收站] 保留期外条目已入队彻底删除: ${created.length}`);
        }
      })
      .catch((err) => {
        console.error('[KB回收站] 自动彻底删除入队失败:', err?.message || err);
      });
  };
  setTimeout(runExpiredRecyclePurge, parseRecycleAutoPurgeInitialDelayMs());
  setInterval(runExpiredRecyclePurge, intervalMs);
}

function parseKbJobTtlIntervalMs() {
  const raw = Number.parseInt(String(process.env.KB_JOB_TTL_INTERVAL_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 60000) {
    return raw;
  }
  return 24 * 60 * 60 * 1000;
}

function parseKbJobTtlInitialDelayMs() {
  const raw = Number.parseInt(String(process.env.KB_JOB_TTL_INITIAL_DELAY_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return 300000;
}

if (String(process.env.KB_JOB_TTL_PURGE_ENABLED || '').toLowerCase() === 'true') {
  const runKbJobTtlPurge = () => {
    purgeExpiredDoneKbJobs()
      .then((result) => {
        if (result.skipped) {
          return;
        }
        if (result.deleted > 0) {
          console.log(`[KB任务TTL] 已删除过期 done 任务行: ${result.deleted}`);
        }
      })
      .catch((err) => {
        console.error('[KB任务TTL] 清理失败:', err?.message || err);
      });
  };
  setTimeout(runKbJobTtlPurge, parseKbJobTtlInitialDelayMs());
  setInterval(runKbJobTtlPurge, parseKbJobTtlIntervalMs());
}

const gracefulShutdown = async (signal) => {
  console.log(`[队列系统] 收到 ${signal}，开始关闭队列...`);
  try {
    await kbIngestQueue.close();
    await kbPurgeQueue.close();
    process.exit(0);
  } catch (error) {
    console.error('[队列系统] 队列关闭失败:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = {
  kbIngestQueue,
  kbPurgeQueue
};

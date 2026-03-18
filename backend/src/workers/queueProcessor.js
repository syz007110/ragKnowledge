const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { kbIngestQueue } = require('../config/queue');
const { processKbIngestJob } = require('./kbIngestProcessor');

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

const gracefulShutdown = async (signal) => {
  console.log(`[队列系统] 收到 ${signal}，开始关闭队列...`);
  try {
    await kbIngestQueue.close();
    process.exit(0);
  } catch (error) {
    console.error('[队列系统] 队列关闭失败:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = {
  kbIngestQueue
};

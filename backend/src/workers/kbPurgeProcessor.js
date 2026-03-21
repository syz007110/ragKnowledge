const {
  executeRecyclePurgeJob
} = require('../services/kbService');
const { publishKbTaskStatus } = require('../services/wsEventPublisher');

async function processKbPurgeJob(job) {
  const { kbJobId } = job.data || {};
  if (!kbJobId) {
    throw new Error('kb.recycle.invalidPurgePayload');
  }
  try {
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'processing',
      progress: 5,
      fileId: Number(job.data?.bizType === 'file' ? job.data?.bizId : 0),
      collectionId: null,
      jobType: 'purge'
    });
    await job.progress(10);
    const result = await executeRecyclePurgeJob({ kbJobId });
    await job.progress(100);
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'done',
      progress: 100,
      fileId: Number(job.data?.bizType === 'file' ? job.data?.bizId : 0),
      collectionId: null,
      jobType: 'purge'
    });
    return {
      queueJobId: job.id,
      ...result,
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'failed',
      progress: Number(job.progress() || 0),
      fileId: Number(job.data?.bizType === 'file' ? job.data?.bizId : 0),
      collectionId: null,
      jobType: 'purge',
      error: error.message
    });
    throw error;
  }
}

module.exports = {
  processKbPurgeJob
};

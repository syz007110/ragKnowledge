const {
  executeRecyclePurgeJob
} = require('../services/kbService');

async function processKbPurgeJob(job) {
  const { kbJobId } = job.data || {};
  if (!kbJobId) {
    throw new Error('kb.recycle.invalidPurgePayload');
  }
  await job.progress(10);
  const result = await executeRecyclePurgeJob({ kbJobId });
  await job.progress(100);
  return {
    queueJobId: job.id,
    ...result,
    processedAt: new Date().toISOString()
  };
}

module.exports = {
  processKbPurgeJob
};

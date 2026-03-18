const { kbIngestQueue } = require('../config/queue');

const QUEUE_NAME = 'kb-ingest';

function createIngestQueue() {
  return kbIngestQueue;
}

module.exports = {
  QUEUE_NAME,
  createIngestQueue
};

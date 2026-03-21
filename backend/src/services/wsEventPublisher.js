const redis = require('redis');

const CHANNEL_KB_TASK_STATUS = 'ws:kb_task_status';
let pubClient = null;
let connecting = null;

function getRedisClientOptions() {
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || 6379);
  const password = process.env.REDIS_PASSWORD || undefined;
  const db = Number(process.env.REDIS_DB || 0);
  const url = process.env.REDIS_URL || `redis://${host}:${port}`;
  const options = { url };
  if (password) options.password = password;
  if (Number.isFinite(db)) options.database = db;
  return options;
}

async function ensurePublisher() {
  if (pubClient && pubClient.isOpen) return pubClient;
  if (connecting) return connecting;
  connecting = (async () => {
    const client = redis.createClient(getRedisClientOptions());
    client.on('error', (error) => {
      console.error('[wsEventPublisher] redis pub error:', error.message);
    });
    await client.connect();
    pubClient = client;
    return pubClient;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function publishKbTaskStatus(payload) {
  try {
    const client = await ensurePublisher();
    if (!client?.isOpen) return false;
    await client.publish(CHANNEL_KB_TASK_STATUS, JSON.stringify({
      ...payload,
      timestamp: Date.now(),
      source: `pid_${process.pid}`
    }));
    return true;
  } catch (error) {
    console.warn('[wsEventPublisher] publish kb task status failed:', error.message);
    return false;
  }
}

module.exports = {
  CHANNEL_KB_TASK_STATUS,
  publishKbTaskStatus
};

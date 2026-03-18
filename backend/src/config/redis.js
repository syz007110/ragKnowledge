const Redis = require('redis');

function createRedisClient() {
  const client = Redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379)
    },
    password: process.env.REDIS_PASSWORD || undefined,
    database: Number(process.env.REDIS_DB || 0)
  });

  client.on('error', (error) => {
    console.error('[redis] error:', error.message);
  });

  return client;
}

module.exports = {
  createRedisClient
};

const path = require('path');
const dotenv = require('dotenv');
const http = require('http');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = require('./app');
const { testDatabaseConnection } = require('./config/mysql');
const websocketService = require('./services/websocketService');

const port = Number(process.env.PORT || 3301);

async function startServer() {
  try {
    await testDatabaseConnection();
    console.log('[bootstrap] database connected');
  } catch (error) {
    console.warn('[bootstrap] database connection failed:', error.message);
  }

  const server = http.createServer(app);
  websocketService.initialize(server);
  server.listen(port, () => {
    console.log(`[bootstrap] MKnowledge backend listening on :${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer
};

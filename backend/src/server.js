const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = require('./app');
const { testDatabaseConnection } = require('./config/mysql');

const port = Number(process.env.PORT || 3301);

async function startServer() {
  try {
    await testDatabaseConnection();
    console.log('[bootstrap] database connected');
  } catch (error) {
    console.warn('[bootstrap] database connection failed:', error.message);
  }

  app.listen(port, () => {
    console.log(`[bootstrap] MKnowledge backend listening on :${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer
};

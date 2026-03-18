const cluster = require('cluster');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

global.clusterManager = null;

if (cluster.isPrimary) {
  console.log('='.repeat(60));
  console.log('🧠 MKnowledge 集群启动器');
  console.log('='.repeat(60));

  const ClusterManager = require('./clusterManager');
  const clusterManager = new ClusterManager();
  global.clusterManager = clusterManager;
  clusterManager.startMaster();

  const gracefulShutdown = async (signal) => {
    console.log(`[主进程] 收到 ${signal}，开始优雅关闭...`);
    await clusterManager.gracefulShutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', async (error) => {
    console.error('[主进程] 未捕获异常:', error);
    await clusterManager.gracefulShutdown();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[主进程] 未处理Promise拒绝:', reason);
  });
} else {
  const role = process.env.WORKER_ROLE || 'api';
  const id = process.env.WORKER_ID || '0';
  console.log(`[子进程 ${id}] 启动，角色: ${role}, pid: ${process.pid}`);

  if (role === 'queue') {
    require('../workers/queueProcessor');
  } else {
    const { startServer } = require('../server');
    startServer();
  }
}

module.exports = {
  clusterManager: global.clusterManager
};

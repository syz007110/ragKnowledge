const cluster = require('cluster');
const os = require('os');

class ClusterManager {
  constructor() {
    this.cpuCount = os.cpus().length;
    this.apiWorkers = Number(process.env.API_WORKER_PROCESSES || Math.max(1, this.cpuCount - 1));
    this.queueWorkers = Number(process.env.QUEUE_WORKER_PROCESSES || 1);
    this.workers = new Map();
    this.isShuttingDown = false;
    this.restartDelayMs = Number(process.env.CLUSTER_RESTART_DELAY_MS || 1000);
  }

  startMaster() {
    console.log('[集群管理器] 主进程启动');
    console.log(`[集群管理器] CPU核心数: ${this.cpuCount}`);
    console.log(`[集群管理器] API进程数: ${this.apiWorkers}`);
    console.log(`[集群管理器] 队列进程数: ${this.queueWorkers}`);

    let workerIndex = 0;
    for (let i = 0; i < this.apiWorkers; i++) {
      this.forkWorker(workerIndex++, 'api');
    }
    for (let i = 0; i < this.queueWorkers; i++) {
      this.forkWorker(workerIndex++, 'queue');
    }

    cluster.on('exit', (worker, code, signal) => {
      const info = this.findWorker(worker.process.pid);
      console.warn(`[集群管理器] 子进程退出 pid=${worker.process.pid}, role=${info?.role}, code=${code}, signal=${signal}`);
      if (!info) return;
      this.workers.delete(info.id);

      if (this.isShuttingDown) {
        console.log(`[集群管理器] 关闭中，忽略子进程重启 workerId=${info.id}`);
        return;
      }

      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.forkWorker(info.id, info.role);
        }
      }, this.restartDelayMs);
    });
  }

  forkWorker(workerId, role) {
    const worker = cluster.fork({
      WORKER_ID: String(workerId),
      WORKER_ROLE: role,
      NODE_ENV: process.env.NODE_ENV || 'development'
    });
    this.workers.set(workerId, { worker, role });
    console.log(`[集群管理器] 创建子进程 workerId=${workerId}, role=${role}, pid=${worker.process.pid}`);
    worker.on('online', () => {
      console.log(`[集群管理器] 子进程就绪 workerId=${workerId}, role=${role}, pid=${worker.process.pid}`);
    });
  }

  findWorker(pid) {
    for (const [id, item] of this.workers.entries()) {
      if (item.worker.process.pid === pid) {
        return { id, role: item.role };
      }
    }
    return null;
  }

  async gracefulShutdown() {
    this.isShuttingDown = true;
    const all = Array.from(this.workers.values()).map(({ worker }) => {
      return new Promise((resolve) => {
        worker.once('exit', () => resolve());
        worker.kill('SIGTERM');
        setTimeout(() => {
          try {
            worker.kill('SIGKILL');
          } catch (_) {}
          resolve();
        }, 4000);
      });
    });
    await Promise.all(all);
  }
}

module.exports = ClusterManager;

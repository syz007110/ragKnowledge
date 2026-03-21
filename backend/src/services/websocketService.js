const redis = require('redis');

const { CHANNEL_KB_TASK_STATUS } = require('./wsEventPublisher');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map();
    this.subClient = null;
    this.WebSocket = null;
    this.enabled = true;
  }

  getRedisClientOptions() {
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

  initialize(server) {
    if (this.wss) return;
    try {
      // Load lazily so missing dependency won't crash process startup.
      this.WebSocket = require('ws');
    } catch (error) {
      this.enabled = false;
      console.warn('[websocket] module "ws" is missing, realtime push disabled.');
      return;
    }
    this.wss = new this.WebSocket.Server({ server, path: '/ws' });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (error) => {
      console.error('[websocket] server error:', error.message);
    });
    this.initializeSubscriber().catch((error) => {
      console.warn('[websocket] redis subscriber init failed:', error.message);
    });
    console.log('[websocket] service initialized on /ws');
  }

  async initializeSubscriber() {
    if (this.subClient?.isOpen) return;
    const client = redis.createClient(this.getRedisClientOptions());
    client.on('error', (error) => {
      console.error('[websocket] redis sub error:', error.message);
    });
    await client.connect();
    await client.subscribe(CHANNEL_KB_TASK_STATUS, (message) => {
      try {
        const payload = JSON.parse(message);
        this.broadcast({
          type: 'kb_task_status',
          ...payload
        });
      } catch (error) {
        console.error('[websocket] parse kb_task_status failed:', error.message);
      }
    });
    this.subClient = client;
    console.log('[websocket] redis subscriber ready');
  }

  handleConnection(ws) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.clients.set(clientId, ws);
    this.sendToClient(clientId, {
      type: 'connection',
      clientId,
      message: 'connected',
      timestamp: Date.now()
    });
    ws.on('message', (data) => {
      let message = null;
      try {
        message = JSON.parse(String(data || '{}'));
      } catch (_) {
        message = null;
      }
      if (message?.type === 'ping') {
        this.sendToClient(clientId, { type: 'pong', timestamp: Date.now() });
      }
    });
    ws.on('close', () => {
      this.clients.delete(clientId);
    });
    ws.on('error', () => {
      this.clients.delete(clientId);
    });
  }

  sendToClient(clientId, message) {
    const ws = this.clients.get(clientId);
    if (!this.WebSocket || !ws || ws.readyState !== this.WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  broadcast(message) {
    this.clients.forEach((_, clientId) => this.sendToClient(clientId, message));
  }

  getStats() {
    return {
      totalClients: this.clients.size
    };
  }
}

module.exports = new WebSocketService();

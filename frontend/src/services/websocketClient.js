class WebSocketClient {
  constructor() {
    this.ws = null;
    this.isConnecting = false;
    this.connectionStatus = 'disconnected';
    this.handlers = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6;
    this.reconnectDelayMs = 1000;
    this.heartbeatTimer = null;
  }

  buildWsUrl() {
    const override = process.env.VUE_APP_WS_URL;
    if (override) return override;
    const apiBase = process.env.VUE_APP_API_BASE_URL || 'http://localhost:3301';
    try {
      const parsed = new URL(apiBase);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${parsed.host}/ws`;
    } catch (_) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws`;
    }
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.isConnecting) return;
    this.isConnecting = true;
    this.connectionStatus = 'connecting';
    const url = this.buildWsUrl();
    try {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.isConnecting = false;
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        this.trigger('connection', { status: 'connected', timestamp: Date.now() });
        this.startHeartbeat();
      };
      this.ws.onmessage = (event) => {
        let message = null;
        try {
          message = JSON.parse(String(event.data || '{}'));
        } catch (_) {
          message = null;
        }
        if (!message) return;
        if (message.type === 'pong') return;
        if (message.type === 'kb_task_status') {
          this.trigger('kbTaskStatus', message);
        }
        this.trigger('message', message);
      };
      this.ws.onclose = () => {
        this.isConnecting = false;
        this.connectionStatus = 'disconnected';
        this.stopHeartbeat();
        this.trigger('disconnection', { status: 'disconnected', timestamp: Date.now() });
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.isConnecting = false;
        this.connectionStatus = 'disconnected';
      };
    } catch (_) {
      this.isConnecting = false;
      this.connectionStatus = 'disconnected';
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectDelayMs * (2 ** (this.reconnectAttempts - 1)), 30000);
    setTimeout(() => this.connect(), delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client_close');
      } catch (_) {}
    }
    this.ws = null;
    this.connectionStatus = 'disconnected';
    this.isConnecting = false;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }

  off(event, handler) {
    const handlers = this.handlers.get(event) || [];
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  trigger(event, payload) {
    const handlers = this.handlers.get(event) || [];
    handlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (_) {}
    });
  }

  getConnectionStatus() {
    return this.connectionStatus;
  }
}

export default new WebSocketClient();

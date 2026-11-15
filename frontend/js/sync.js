/**
 * WebSocket-клиент: переподключение с экспоненциальной задержкой,
 * отправка/приём JSON-сообщений.
 */

const MAX_BACKOFF_MS = 10000;
const BASE_BACKOFF_MS = 500;

const CLOSE_REASONS = {
  4400: 'invalid_room',
  4401: 'unauthorized',
  4403: 'forbidden',
  4409: 'replaced',
};

export class SyncClient {
  constructor({ roomId, token, onEvent, onStatus, onFatal }) {
    this.roomId = roomId;
    this.token = token;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onFatal = onFatal ?? (() => {});

    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
  }

  connect() {
    if (this.closed) return;
    this.onStatus?.('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws/${encodeURIComponent(
      this.roomId,
    )}?token=${encodeURIComponent(this.token)}`;

    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.onStatus?.('open');
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onEvent?.(message);
    };

    socket.onerror = () => {
      // onclose всегда придёт следом — переподключением занимается он.
    };

    socket.onclose = (event) => {
      this.ws = null;
      if (this.closed) return;

      if (event.code >= 4400) {
        this.closed = true;
        const reason = event.reason || CLOSE_REASONS[event.code] || 'closed';
        this.onFatal(reason);
        return;
      }

      this.onStatus?.('closed');
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this.closed) return;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(backoff * jitter);
    this.attempt += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.close(1000, 'client_closed');
      } catch {
        /* noop */
      }
    }
  }
}

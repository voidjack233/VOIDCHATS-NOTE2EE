import { GATEWAY_ORIGIN, GATEWAY_URL } from '../config';
import type { PresenceActivityStatus } from '../features/presence/presenceStatus';
import { refreshSession } from './api';

export type GatewayConnectionState = 'connected' | 'reconnecting' | 'disconnected';
type Handler = (data: unknown) => void;

const OP = {
  EVENT: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HEARTBEAT_ACK: 3,
  STATUS_UPDATE: 4,
  RESUME: 6,
  RESUMED: 7,
  HELLO: 10,
} as const;

const runtimeId = `native-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

class NativeGateway {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private userId: string | null = null;
  private sessionId: string | null = null;
  private lastSequence = 0;
  private canResume = false;
  private intentionalClose = false;
  private presence: PresenceActivityStatus = 'online';
  private connectionState: GatewayConnectionState = 'disconnected';
  private heartbeatAcknowledged = true;
  private missedHeartbeats = 0;

  connect(userId: string) {
    if (
      this.userId === userId &&
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) return;

    this.userId = userId;
    this.intentionalClose = false;
    this.setState('reconnecting');
    this.socket?.close();
    const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
    const socket = new NativeWebSocket(GATEWAY_URL, null, {
      headers: { Origin: GATEWAY_ORIGIN },
    });
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
    };
    socket.onmessage = (event) => {
      try {
        this.handleMessage(JSON.parse(String(event.data)) as {
          op: number;
          t?: string;
          s?: number;
          d?: Record<string, unknown>;
        });
      } catch {
        // Ignore malformed gateway frames and retain the connection.
      }
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      if (this.intentionalClose) return;
      if (this.sessionId && this.lastSequence > 0) this.canResume = true;
      this.setState('reconnecting');
      if (event.code === 4001 || event.code === 4003) {
        void refreshSession().then((result) => {
          if (result === 'ok') this.scheduleReconnect(100);
          else if (result === 'unavailable') this.scheduleReconnect();
          else this.setState('disconnected');
        });
      } else {
        if (event.code === 4007 || event.code === 4009) this.invalidateResume();
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(frame: {
    op: number;
    t?: string;
    s?: number;
    d?: Record<string, unknown>;
  }) {
    if (frame.op === OP.EVENT && typeof frame.s === 'number') this.lastSequence = frame.s;
    if (frame.op === OP.HEARTBEAT_ACK) {
      this.heartbeatAcknowledged = true;
      this.missedHeartbeats = 0;
      return;
    }
    if (frame.op === OP.HELLO) {
      const interval = Number(frame.d?.heartbeat_interval) || 30_000;
      this.startHeartbeat(interval);
      this.send(this.canResume && this.sessionId ? {
        op: OP.RESUME,
        d: {
          session_id: this.sessionId,
          last_sequence: this.lastSequence,
          presence_status: this.presence,
        },
      } : {
        op: OP.IDENTIFY,
        d: {
          user_id: this.userId,
          client_instance_id: runtimeId,
          presence_status: this.presence,
        },
      });
      return;
    }
    if (frame.op === OP.RESUMED) {
      this.canResume = false;
      this.setState('connected');
      this.emit('RESUMED', frame.d || {});
      return;
    }
    if (frame.op !== OP.EVENT || !frame.t) return;
    if (frame.t === 'READY') {
      this.sessionId = typeof frame.d?.session_id === 'string' ? frame.d.session_id : null;
      this.canResume = false;
      this.setState('connected');
    } else if (frame.t === 'TOKEN_EXPIRING') {
      void refreshSession().then((result) => {
        if (result !== 'ok' || !this.userId) return;
        const userId = this.userId;
        const staleSocket = this.socket;
        this.socket = null;
        staleSocket?.close();
        this.connect(userId);
      });
    } else if (frame.t === 'SHUTDOWN') {
      this.canResume = Boolean(this.sessionId && this.lastSequence);
      const delay = Number(frame.d?.in) || 5_000;
      this.socket?.close();
      this.scheduleReconnect(delay);
    }
    this.emit(frame.t, frame.d || {});
  }

  private startHeartbeat(interval: number) {
    this.stopHeartbeat();
    this.heartbeatAcknowledged = true;
    this.missedHeartbeats = 0;
    this.heartbeat = setInterval(() => {
      if (!this.heartbeatAcknowledged) this.missedHeartbeats += 1;
      if (this.missedHeartbeats >= 2) {
        const staleSocket = this.socket;
        this.socket = null;
        this.stopHeartbeat();
        if (this.sessionId && this.lastSequence > 0) this.canResume = true;
        staleSocket?.close();
        this.setState('reconnecting');
        this.scheduleReconnect(100);
        return;
      }
      this.heartbeatAcknowledged = false;
      this.send({ op: OP.HEARTBEAT, d: { status: this.presence } });
    }, interval);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.heartbeatAcknowledged = true;
    this.missedHeartbeats = 0;
  }

  private scheduleReconnect(forcedDelay?: number) {
    if (this.intentionalClose || !this.userId || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = forcedDelay ?? Math.min(1_000 * (2 ** this.reconnectAttempts), 30_000) + Math.random() * 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userId) this.connect(this.userId);
    }, delay);
  }

  reconnectNow() {
    if (!this.userId || this.intentionalClose) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.connect(this.userId);
  }

  setPresence(status: PresenceActivityStatus) {
    if (status === this.presence) return;
    this.presence = status;
    this.emit('LOCAL_PRESENCE_ACTIVITY', { status });
    this.send({ op: OP.STATUS_UPDATE, d: { status } });
  }

  getPresenceStatus(): PresenceActivityStatus {
    return this.presence;
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.userId = null;
    this.invalidateResume();
    this.setState('disconnected');
    if (this.presence !== 'online') {
      this.presence = 'online';
      this.emit('LOCAL_PRESENCE_ACTIVITY', { status: 'online' });
    }
  }

  getState() {
    return this.connectionState;
  }

  on(event: string, handler: Handler) {
    const current = this.handlers.get(event) || new Set<Handler>();
    current.add(handler);
    this.handlers.set(event, current);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private emit(event: string, data: unknown) {
    this.handlers.get(event)?.forEach((handler) => handler(data));
  }

  private setState(state: GatewayConnectionState) {
    if (state === this.connectionState) return;
    this.connectionState = state;
    this.emit('CONNECTION_STATE', { state });
  }

  private invalidateResume() {
    this.sessionId = null;
    this.lastSequence = 0;
    this.canResume = false;
  }
}

export const gateway = new NativeGateway();

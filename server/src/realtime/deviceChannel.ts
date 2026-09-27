import type { ServerToDeviceMessage } from '@sylvan/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { DeviceEventStore } from '../services/deviceEvents.js';
import type { DeviceLogStore } from '../services/deviceLogs.js';
import type { DeviceStatusTracker } from './deviceStatus.js';
import {
  CLOSE,
  MAX_BAD_MESSAGES,
  MAX_DEVICE_TEXT_MESSAGE_BYTES,
  deviceHeartbeatSchema,
  deviceHelloSchema,
  deviceLogSchema,
  isJpegFrame,
  parseTextMessage,
} from './protocol.js';

interface DeviceConnection {
  socket: WebSocket;
  badMessages: number;
  missedPongs: number;
  replaced: boolean;
}

export interface DeviceChannelOptions {
  status: DeviceStatusTracker;
  events: DeviceEventStore;
  /** Debug trail storage; absent in tests that do not exercise logging. */
  logs?: DeviceLogStore;
  log: FastifyBaseLogger;
  maxFrameBytes: number;
  targetFps: number;
  jpegQuality: number;
  onConnected: () => void;
  onDisconnected: () => void;
  onFrame: (frame: Buffer) => void;
}

const LOG_LEVELS = { d: 'debug', i: 'info', w: 'warn', e: 'error' } as const;

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/** Handles the single rover connection on `/ws/device`. */
export class DeviceChannel {
  private current: DeviceConnection | null = null;

  constructor(private readonly options: DeviceChannelOptions) {}

  get connected() {
    return this.current !== null;
  }

  handleConnection(socket: WebSocket, remoteAddress: string | undefined) {
    const { log, status, events } = this.options;
    const previous = this.current;
    if (previous) {
      // A rebooted rover must never be locked out by its own stale socket.
      previous.replaced = true;
      log.warn({ remoteAddress }, 'device reconnected; replacing the previous connection');
      previous.socket.close(CLOSE.replaced, 'replaced');
    }

    const connection: DeviceConnection = {
      socket,
      badMessages: 0,
      missedPongs: 0,
      replaced: false,
    };
    this.current = connection;
    status.connected();
    events.record('connected', { lastSeenAt: new Date().toISOString() });
    log.info({ remoteAddress }, 'device connected');

    this.send({
      type: 'config',
      targetFps: this.options.targetFps,
      jpegQuality: this.options.jpegQuality,
    });
    this.options.onConnected();

    socket.on('message', (data, isBinary) => {
      // A bug here must never crash the process: one misbehaving connection would take down
      // every other device and viewer on a shared server.
      try {
        this.handleMessage(connection, toBuffer(data), isBinary);
      } catch (error) {
        log.error({ err: error }, 'error handling device message');
      }
    });
    socket.on('pong', () => {
      connection.missedPongs = 0;
    });
    socket.on('error', (error) => {
      log.warn({ err: error }, 'device socket error');
    });
    socket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString('utf8').slice(0, 100);
      log.info({ code, reason, replaced: connection.replaced }, 'device disconnected');
      if (this.current !== connection) return;
      this.current = null;
      const snapshot = status.snapshot();
      status.disconnected();
      events.record('disconnected', {
        code,
        ...(reason ? { reason } : {}),
        ...(snapshot.lastSeenAt ? { lastSeenAt: snapshot.lastSeenAt } : {}),
      });
      this.options.onDisconnected();
    });
  }

  private violation(connection: DeviceConnection, what: string) {
    connection.badMessages++;
    this.options.log.debug({ what, count: connection.badMessages }, 'invalid device message');
    if (connection.badMessages > MAX_BAD_MESSAGES) {
      this.options.log.warn('closing device connection after too many invalid messages');
      connection.socket.close(CLOSE.protocolViolation, 'too many invalid messages');
    }
  }

  private handleMessage(connection: DeviceConnection, data: Buffer, isBinary: boolean) {
    if (this.current !== connection) return;
    const { status, events, log } = this.options;

    if (isBinary) {
      if (!isJpegFrame(data)) {
        this.violation(connection, 'frame is not a JPEG');
        return;
      }
      if (data.length > this.options.maxFrameBytes) {
        this.violation(connection, 'frame too large');
        return;
      }
      status.frame();
      this.options.onFrame(data);
      return;
    }

    const parsed = parseTextMessage(data, MAX_DEVICE_TEXT_MESSAGE_BYTES);
    if (parsed.kind === 'invalid') {
      this.violation(connection, 'malformed JSON');
      return;
    }

    switch (parsed.type) {
      case 'hello': {
        const hello = deviceHelloSchema.safeParse(parsed.value);
        if (!hello.success) {
          this.violation(connection, 'invalid hello');
          return;
        }
        const { fw, bootId } = hello.data;
        const newBoot = status.hello({ fw, bootId });
        if (newBoot) {
          const detail = { ...(bootId ? { bootId } : {}), ...(fw ? { fw } : {}) };
          events.record('boot', detail);
          log.info(detail, 'device booted');
        }
        return;
      }
      case 'heartbeat': {
        const heartbeat = deviceHeartbeatSchema.safeParse(parsed.value);
        if (!heartbeat.success) {
          this.violation(connection, 'invalid heartbeat');
          return;
        }
        status.heartbeat(heartbeat.data);
        return;
      }
      case 'log': {
        const batch = deviceLogSchema.safeParse(parsed.value);
        if (!batch.success) {
          this.violation(connection, 'invalid log batch');
          return;
        }
        this.options.logs?.append(
          batch.data.bootId ?? status.currentBootId,
          batch.data.entries.map((entry) => ({
            source: entry.src === 'a' ? 'atmega' : 'esp32',
            level: LOG_LEVELS[entry.lvl],
            deviceMs: entry.ms ?? null,
            message: entry.msg,
          })),
        );
        return;
      }
      default:
        log.debug({ type: parsed.type }, 'ignoring unknown device message type');
    }
  }

  send(message: ServerToDeviceMessage) {
    const socket = this.current?.socket;
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  /** Pings the device; terminates it after two unanswered pings. */
  ping() {
    const connection = this.current;
    if (!connection) return;
    if (connection.missedPongs >= 2) {
      this.options.log.warn('device missed two pings; terminating the connection');
      connection.socket.terminate();
      return;
    }
    connection.missedPongs++;
    connection.socket.ping();
  }

  close(code: number, reason: string) {
    this.current?.socket.close(code, reason);
  }
}

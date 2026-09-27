import type { IncomingMessage, Server } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DeviceStatus, StreamState, StreamStopReason } from '@sylvan/shared';
import proxyAddr from '@fastify/proxy-addr';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer } from 'ws';
import { isValidDeviceKey } from '../lib/auth.js';
import { errorBody } from '../lib/errors.js';
import type { DeviceEventStore } from '../services/deviceEvents.js';
import type { DeviceLogStore } from '../services/deviceLogs.js';
import type { EventBus } from '../services/events.js';
import { DeviceChannel } from './deviceChannel.js';
import { DeviceStatusTracker } from './deviceStatus.js';
import { CLOSE, MAX_TEXT_MESSAGE_BYTES } from './protocol.js';
import { StreamRelay, ViewerCountNotifier } from './relay.js';
import { ViewerChannel } from './viewerChannel.js';

export interface RealtimeConfig {
  deviceTimeoutMs: number;
  maxFrameBytes: number;
  slowViewerBytes: number;
  targetFps: number;
  jpegQuality: number;
  maxViewers: number;
  maxMessageBytes: number;
  /** New /ws/live connections allowed per IP per minute. Undefined means unlimited. */
  maxNewViewerConnectionsPerMinute?: number;
  /** Trusted proxy list, in the same format as Fastify's `trustProxy`, used to resolve the real
   *  client IP for the connections-per-minute limiter (WebSocket upgrades bypass `request.ip`). */
  trustProxy?: string[];
  /** Timing overrides, mainly for tests. */
  tickMs?: number;
  pingIntervalMs?: number;
  slowCloseMs?: number;
  maxIncomingFps?: number;
  viewersStartDelayMs?: number;
  viewersStopDelayMs?: number;
  viewersThrottleMs?: number;
  statsLogIntervalMs?: number;
}

export interface Realtime {
  init(): Promise<void>;
  status(): DeviceStatus;
  health(): { viewers: number; deviceOnline: boolean };
  /** Closes every socket with 1001, stops timers and waits for pending event writes. */
  close(): Promise<void>;
  /** For tests: number of timers still scheduled. */
  activeTimers(): number;
  readonly device: DeviceChannel;
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  code: string,
  message: string,
  retryAfterS?: number,
) {
  const body = JSON.stringify(errorBody(code, message));
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      (retryAfterS !== undefined ? `Retry-After: ${String(retryAfterS)}\r\n` : '') +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

const CONNECTION_WINDOW_MS = 60_000;

/** Fixed-window "N new connections per IP per minute" counter for the /ws/live upgrade path. */
class ConnectionRateLimiter {
  private readonly windows = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  /** Returns true and counts the attempt when it is allowed. */
  tryConsume(key: string): boolean {
    const now = this.now();
    const entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= CONNECTION_WINDOW_MS) {
      this.windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  /** Drops windows that have already expired, so the map does not grow without bound. */
  sweep() {
    const now = this.now();
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= CONNECTION_WINDOW_MS) this.windows.delete(key);
    }
  }
}

export function createRealtime(deps: {
  server: Server;
  config: RealtimeConfig;
  bus: EventBus;
  events: DeviceEventStore;
  logs?: DeviceLogStore;
  deviceKey: string;
  log: FastifyBaseLogger;
  now?: () => number;
}): Realtime {
  const { server, config, bus, events, deviceKey } = deps;
  const log = deps.log.child({ module: 'realtime' });
  const now = deps.now ?? Date.now;
  const tickMs = config.tickMs ?? 1000;
  const pingIntervalMs = config.pingIntervalMs ?? 20_000;
  const statsLogIntervalMs = config.statsLogIntervalMs ?? 60_000;

  let statusDirty = false;
  let streamLive = false;
  let closing = false;

  const status = new DeviceStatusTracker({
    timeoutMs: config.deviceTimeoutMs,
    now,
    onChange: (urgent) => {
      statusDirty = true;
      if (urgent) flushStatus();
    },
  });

  const relay = new StreamRelay({
    slowViewerBytes: config.slowViewerBytes,
    slowCloseMs: config.slowCloseMs ?? 10_000,
    maxFps: config.maxIncomingFps ?? 10,
    now,
    onSlowClose: () => {
      log.info('closing a viewer that stayed too slow for the stream');
      watchersChanged(relay.watcherCount);
    },
  });

  const streamState = (): { state: StreamState; reason: StreamStopReason | null } => {
    if (!status.isOnline) return { state: 'stopped', reason: 'device_offline' };
    if (relay.watcherCount === 0) return { state: 'stopped', reason: 'no_viewers' };
    return { state: streamLive ? 'live' : 'starting', reason: null };
  };

  const viewers = new ViewerChannel({
    relay,
    log,
    getStatus: () => status.snapshot(),
    getStreamState: streamState,
    onWatchersChanged: (count) => {
      watchersChanged(count);
    },
  });

  const device = new DeviceChannel({
    status,
    events,
    ...(deps.logs ? { logs: deps.logs } : {}),
    log,
    maxFrameBytes: config.maxFrameBytes,
    targetFps: config.targetFps,
    jpegQuality: config.jpegQuality,
    onConnected: () => {
      notifier.deviceConnected();
      if (relay.watcherCount > 0) {
        streamLive = false;
        viewers.broadcastToWatchers({ type: 'stream.state', ...streamState() });
      }
    },
    onDisconnected: () => {
      notifier.deviceDisconnected();
      stopStream();
    },
    onFrame: (frame) => {
      if (relay.handleFrame(frame) && !streamLive && relay.watcherCount > 0) {
        streamLive = true;
        viewers.broadcastToWatchers({ type: 'stream.state', state: 'live', reason: null });
      }
    },
  });

  const notifier = new ViewerCountNotifier({
    startDelayMs: config.viewersStartDelayMs ?? 250,
    stopDelayMs: config.viewersStopDelayMs ?? 3000,
    throttleMs: config.viewersThrottleMs ?? 1000,
    now,
    send: (count) => {
      if (device.send({ type: 'viewers', count }))
        log.debug({ count }, 'sent viewer count to device');
    },
  });

  function flushStatus() {
    if (!statusDirty) return;
    statusDirty = false;
    viewers.broadcast({ type: 'device.status', device: status.snapshot() });
  }

  function stopStream() {
    if (relay.watcherCount > 0) {
      viewers.broadcastToWatchers({
        type: 'stream.state',
        state: 'stopped',
        reason: 'device_offline',
      });
    }
    streamLive = false;
  }

  function watchersChanged(count: number) {
    if (count === 0) streamLive = false;
    status.setViewers(count);
    notifier.update(count);
  }

  // Bus events (sample.created, sample.updated, log.appended) go to every viewer as-is.
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === 'verdict.ready') {
      const { uploadId, label, confidence } = event;
      if (device.send({ type: 'verdict', uploadId, label, confidence }))
        log.info({ uploadId, label }, 'sent photo verdict to device');
      return;
    }
    viewers.broadcast(event);
  });

  const connectionLimiter = config.maxNewViewerConnectionsPerMinute
    ? new ConnectionRateLimiter(config.maxNewViewerConnectionsPerMinute, now)
    : null;
  const trustProxyFn = proxyAddr.compile(config.trustProxy ?? ['127.0.0.1', '::1']);

  // Separate servers so each channel has its own message size limit. JPEGs are already
  // compressed, so per-message deflate would only cost CPU.
  const deviceServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: config.maxMessageBytes,
  });
  const viewerServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_TEXT_MESSAGE_BYTES,
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    if (closing) {
      rejectUpgrade(socket, 503, 'SHUTTING_DOWN', 'Server is restarting');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/device') {
      const key = request.headers['x-device-key'] ?? url.searchParams.get('key') ?? undefined;
      if (!isValidDeviceKey(key, deviceKey)) {
        // Never log the URL here: the query form carries the key.
        log.warn(
          { remoteAddress: request.socket.remoteAddress },
          'rejected device connection: bad key',
        );
        rejectUpgrade(socket, 401, 'UNAUTHORIZED', 'Missing or invalid device key');
        return;
      }
      deviceServer.handleUpgrade(request, socket, head, (ws) => {
        device.handleConnection(ws, request.socket.remoteAddress);
      });
      return;
    }
    if (url.pathname === '/ws/live') {
      if (viewers.count >= config.maxViewers) {
        rejectUpgrade(socket, 503, 'TOO_MANY_VIEWERS', 'Live view is full; try again later');
        return;
      }
      if (connectionLimiter) {
        const ip = proxyAddr(request, trustProxyFn);
        if (!connectionLimiter.tryConsume(ip)) {
          rejectUpgrade(
            socket,
            429,
            'RATE_LIMITED',
            'Too many connection attempts. Please try again shortly.',
            60,
          );
          return;
        }
      }
      viewerServer.handleUpgrade(request, socket, head, (ws) => {
        viewers.handleConnection(ws);
      });
      return;
    }
    rejectUpgrade(socket, 404, 'NOT_FOUND', 'Not found');
  };
  server.on('upgrade', onUpgrade);

  // One shared timer drives heartbeat timeouts, status broadcasts, slow viewers and pings.
  let lastPingAt = now();
  let lastStatsAt = now();
  const tick = setInterval(() => {
    if (status.tick()) {
      const snapshot = status.snapshot();
      log.warn('device heartbeat timed out');
      events.record('timeout', {
        ...(snapshot.lastSeenAt ? { lastSeenAt: snapshot.lastSeenAt } : {}),
        ...(snapshot.rssi !== null ? { rssi: snapshot.rssi } : {}),
      });
      stopStream();
    }
    flushStatus();
    relay.tick();
    connectionLimiter?.sweep();
    const current = now();
    if (current - lastPingAt >= pingIntervalMs) {
      lastPingAt = current;
      device.ping();
      viewers.ping();
    }
    if (current - lastStatsAt >= statsLogIntervalMs) {
      lastStatsAt = current;
      const stats = relay.takeStats();
      if (stats.framesIn > 0) log.info({ ...stats, watchers: relay.watcherCount }, 'stream stats');
    }
  }, tickMs);
  tick.unref();

  let timers = 1;

  return {
    device,
    async init() {
      try {
        const restored = await events.restore();
        status.restore(restored.lastSeenAt, restored.bootId);
      } catch (error) {
        log.error({ err: error }, 'could not restore device status');
      }
    },
    status: () => status.snapshot(),
    health: () => ({ viewers: relay.watcherCount, deviceOnline: status.isOnline }),
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(tick);
      timers = 0;
      notifier.cancel();
      unsubscribe();
      server.off('upgrade', onUpgrade);

      const sockets = [...deviceServer.clients, ...viewerServer.clients];
      const closed = Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.readyState === socket.CLOSED) {
                resolve();
                return;
              }
              socket.once('close', () => {
                resolve();
              });
            }),
        ),
      );
      device.close(CLOSE.goingAway, 'server shutting down');
      viewers.closeAll(CLOSE.goingAway, 'server shutting down');
      // Do not let an unresponsive peer hold the shutdown open.
      const force = setTimeout(() => {
        for (const socket of sockets) socket.terminate();
      }, 2000);
      await closed;
      clearTimeout(force);
      relay.clear();
      await Promise.all([
        new Promise((resolve) => {
          deviceServer.close(resolve);
        }),
        new Promise((resolve) => {
          viewerServer.close(resolve);
        }),
      ]);
      await Promise.all([events.flush(), deps.logs?.flush()]);
    },
    activeTimers: () => timers + (notifier.hasTimer ? 1 : 0),
  };
}

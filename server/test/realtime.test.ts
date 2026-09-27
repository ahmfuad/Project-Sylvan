import type { DeviceEventsResponse, DeviceStatus, Sample } from '@sylvan/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEVICE_KEY, fixtureJpeg, resetDatabase, uploadHeaders } from './helpers.js';
import {
  createRealtimeContext,
  frameOf,
  type RealtimeContext,
  type TestClient,
} from './realtime-helpers.js';

let ctx: RealtimeContext;

async function context(overrides: Parameters<typeof createRealtimeContext>[0] = {}) {
  ctx = await createRealtimeContext(overrides);
  await resetDatabase(ctx.sql);
  return ctx;
}

afterEach(async () => {
  await ctx.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the HTTP status when the upgrade is refused, or 101 when it succeeds. */
function upgradeStatus(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers ? { headers } : {});
    socket.once('open', () => {
      socket.close();
      resolve(101);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', (error) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      reject(error);
    });
  });
}

const status = async (): Promise<DeviceStatus> => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/device' });
  expect(res.statusCode).toBe(200);
  return res.json<DeviceStatus>();
};

const events = async (): Promise<DeviceEventsResponse['items']> => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/device/events' });
  expect(res.statusCode).toBe(200);
  return res.json<DeviceEventsResponse>().items;
};

/** Events are written asynchronously, so poll until they satisfy `ready` (or time out). */
const eventsWhen = async (
  ready: (items: DeviceEventsResponse['items']) => boolean,
  timeoutMs = 3000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await events();
    if (ready(items) || Date.now() > deadline) return items;
    await sleep(20);
  }
};

describe('WS /ws/device authentication', () => {
  it('accepts the key as a header or a query parameter', async () => {
    await context();
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/device`, { 'x-device-key': DEVICE_KEY })).toBe(101);
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/device?key=${DEVICE_KEY}`)).toBe(101);
  });

  it('refuses a missing or wrong key with HTTP 401, before the upgrade', async () => {
    await context();
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/device`)).toBe(401);
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/device`, { 'x-device-key': 'wrong' })).toBe(401);
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/device?key=wrong`)).toBe(401);
    expect((await status()).online).toBe(false);
    // The key must never reach the logs, in either form.
    expect(ctx.logs.join('')).not.toContain(DEVICE_KEY);
  });

  it('returns 404 for unknown WebSocket paths', async () => {
    await context();
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/nope`)).toBe(404);
  });

  it('refuses viewers over MAX_VIEWERS with 503', async () => {
    await context({ realtime: { maxViewers: 2 } });
    await ctx.viewer();
    await ctx.viewer();
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/live`)).toBe(503);
  });

  it('caps new /ws/live connections per IP per minute, independent of MAX_VIEWERS', async () => {
    await context({ realtime: { maxViewers: 50, maxNewViewerConnectionsPerMinute: 2 } });
    await ctx.viewer();
    await ctx.viewer();
    expect(await upgradeStatus(`${ctx.wsUrl}/ws/live`)).toBe(429);
  });

  it('does not cap connections when the limit is left unset (the default in every other test)', async () => {
    await context({ realtime: { maxViewers: 50 } });
    for (let i = 0; i < 5; i++) await ctx.viewer();
  });
});

describe('device connection lifecycle', () => {
  it('sends config on connect and records a connected event', async () => {
    await context();
    const device = await ctx.device();
    expect(await device.next((m) => m.type === 'config')).toMatchObject({
      type: 'config',
      targetFps: 5,
      jpegQuality: 65,
    });
    expect((await status()).online).toBe(true);
    expect((await eventsWhen((items) => items.length > 0))[0]).toMatchObject({
      type: 'connected',
    });
  });

  it('replaces an older connection with close code 4002', async () => {
    await context();
    const first = await ctx.device();
    await first.next((m) => m.type === 'config');
    const second = await ctx.device();
    await second.next((m) => m.type === 'config');

    expect(await first.waitForClose()).toEqual({ code: 4002, reason: 'replaced' });
    expect((await status()).online).toBe(true);

    // The replacement keeps working, and the stale socket did not clear the status.
    second.send({ type: 'heartbeat', rssi: -50 });
    await sleep(80);
    expect((await status()).rssi).toBe(-50);
  });

  it('tracks heartbeats and goes offline after DEVICE_TIMEOUT_S, writing one timeout event', async () => {
    await context();
    const device = await ctx.device();
    device.send({ type: 'hello', fw: 'sylvan-esp32cam 1.0.0', bootId: 'boot-1' });
    device.send({
      type: 'heartbeat',
      rssi: -62,
      uptimeS: 1840,
      freeHeap: 142_000,
      streaming: false,
    });
    await sleep(80);

    const online = await status();
    expect(online).toMatchObject({
      online: true,
      rssi: -62,
      uptimeS: 1840,
      freeHeap: 142_000,
      fw: 'sylvan-esp32cam 1.0.0',
      streaming: false,
    });
    expect(online.lastSeenAt).not.toBeNull();

    await sleep(500); // longer than deviceTimeoutMs (300)
    const offline = await status();
    expect(offline.online).toBe(false);
    expect(offline.lastSeenAt).toBe(online.lastSeenAt);

    const types = (await events()).map((event) => event.type);
    expect(types).toContain('timeout');
    expect(types.filter((type) => type === 'timeout')).toHaveLength(1);

    // A later heartbeat brings it back without needing a reconnect.
    device.send({ type: 'heartbeat', rssi: -70 });
    await sleep(80);
    expect((await status()).online).toBe(true);
  });

  it('records boot events only when the boot id changes, and never per heartbeat', async () => {
    await context();
    const device = await ctx.device();
    device.send({ type: 'hello', bootId: 'boot-a', fw: 'fw-1' });
    for (let i = 0; i < 5; i++) device.send({ type: 'heartbeat', rssi: -60 });
    device.send({ type: 'hello', bootId: 'boot-a' });
    let recorded = await eventsWhen((items) => items.some((event) => event.type === 'boot'));
    await sleep(120); // time for any (wrong) extra boot or heartbeat events to land
    expect(recorded.filter((event) => event.type === 'boot')).toHaveLength(1);
    expect(recorded.find((event) => event.type === 'boot')?.detail).toMatchObject({
      bootId: 'boot-a',
      fw: 'fw-1',
    });

    recorded = await events();
    expect(recorded.filter((event) => event.type === 'boot')).toHaveLength(1);

    device.send({ type: 'hello', bootId: 'boot-b' });
    recorded = await eventsWhen(
      (items) => items.filter((event) => event.type === 'boot').length >= 2,
    );
    expect(recorded.filter((event) => event.type === 'boot')).toHaveLength(2);
    // Only connect + two boots so far: heartbeats wrote nothing.
    expect(recorded).toHaveLength(3);
  });

  it('records a disconnected event and clears status when the device goes away', async () => {
    await context();
    const device = await ctx.device();
    device.send({ type: 'heartbeat', rssi: -55 });
    await sleep(60);
    device.socket.close(1000, 'bye');
    await sleep(120);

    const offline = await status();
    expect(offline).toMatchObject({ online: false, connectedAt: null, streaming: false });
    expect(offline.lastSeenAt).not.toBeNull();
    expect((await eventsWhen((items) => items[0]?.type === 'disconnected'))[0]).toMatchObject({
      type: 'disconnected',
      detail: { code: 1000 },
    });
  });
});

describe('device message validation', () => {
  it('ignores unknown message types without penalty', async () => {
    await context();
    const device = await ctx.device();
    for (let i = 0; i < 20; i++) device.send({ type: 'something-else', i });
    device.send({ type: 'heartbeat', rssi: -44 });
    await sleep(120);
    expect(device.closed).toBeNull();
    expect((await status()).rssi).toBe(-44);
  });

  it('rejects non-JPEG and oversized frames, and closes after 10 bad messages', async () => {
    await context();
    const device = await ctx.device();
    const viewer = await ctx.viewer();
    viewer.send({ type: 'watch', on: true });
    await sleep(60);

    device.sendBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header
    device.sendBinary(frameOf(6000)); // over maxFrameBytes (5000)
    device.socket.send('not json at all');
    device.send({ type: 'heartbeat', rssi: 42 }); // out of range
    await sleep(120);
    expect(device.closed).toBeNull();
    expect(viewer.frames).toHaveLength(0);

    for (let i = 0; i < 8; i++) device.sendBinary(Buffer.from([0x00, 0x01]));
    expect(await device.waitForClose()).toMatchObject({ code: 4003 });
  });
});

describe('live stream relay', () => {
  it('sends frames only to watching viewers and reports stream state', async () => {
    await context();
    const device = await ctx.device();
    const watcher = await ctx.viewer();
    const idle = await ctx.viewer();

    expect(await watcher.next((m) => m.type === 'hello')).toMatchObject({
      device: { online: true },
    });

    watcher.send({ type: 'watch', on: true });
    expect(await watcher.next((m) => m.type === 'stream.state')).toMatchObject({
      state: 'starting',
    });
    expect(await device.next((m) => m.type === 'viewers')).toMatchObject({
      type: 'viewers',
      count: 0,
    });

    await device.next((m) => m.type === 'viewers' && m.count === 1);
    const frame = frameOf(1200, 7);
    device.sendBinary(frame);

    expect(await watcher.waitForFrames(1)).toEqual([frame]);
    expect(await watcher.next((m) => m.type === 'stream.state' && m.state === 'live')).toBeTruthy();
    expect(idle.frames).toHaveLength(0);
    expect((await status()).viewers).toBe(1);

    watcher.send({ type: 'watch', on: false });
    expect(
      await watcher.next((m) => m.type === 'stream.state' && m.reason === 'viewer_left'),
    ).toBeTruthy();
    expect(await device.next((m) => m.type === 'viewers' && m.count === 0)).toBeTruthy();

    device.sendBinary(frameOf(1200, 8));
    await sleep(80);
    expect(watcher.frames).toHaveLength(1);
  });

  it('fans one frame out to several watchers and stops when the device disconnects', async () => {
    await context();
    const device = await ctx.device();
    const a = await ctx.viewer();
    const b = await ctx.viewer();
    a.send({ type: 'watch', on: true });
    b.send({ type: 'watch', on: true });
    await device.next((m) => m.type === 'viewers' && m.count === 2);

    device.sendBinary(frameOf(900, 3));
    await a.waitForFrames(1);
    await b.waitForFrames(1);

    device.socket.close();
    expect(
      await a.next((m) => m.type === 'stream.state' && m.reason === 'device_offline'),
    ).toBeTruthy();
    expect(
      await b.next((m) => m.type === 'device.status' && !(m.device as DeviceStatus).online),
    ).toBeTruthy();
  });

  it('tells a viewer the device is offline when it starts watching', async () => {
    await context();
    const viewer = await ctx.viewer();
    viewer.send({ type: 'watch', on: true });
    expect(await viewer.next((m) => m.type === 'stream.state')).toMatchObject({
      state: 'stopped',
      reason: 'device_offline',
    });
  });

  it('closes a viewer that cannot keep up, while the others keep receiving', async () => {
    await context({
      realtime: {
        slowViewerBytes: 4000,
        slowCloseMs: 150,
        maxFrameBytes: 200_000,
        maxMessageBytes: 300_000,
      },
    });
    const device = await ctx.device();
    const slow = await ctx.viewer();
    const fast = await ctx.viewer();
    slow.send({ type: 'watch', on: true });
    fast.send({ type: 'watch', on: true });
    await device.next((m) => m.type === 'viewers' && m.count === 2);

    // Stop reading on the slow client so the server's send buffer fills up. While it is paused
    // the client cannot see the close frame either, so the server side is checked first.
    const rawSocket = (slow.socket as unknown as { _socket: { pause(): void; resume(): void } })
      ._socket;
    rawSocket.pause();

    const big = frameOf(150_000, 9);
    const deadline = Date.now() + 5000;
    let dropped = false;
    while (!dropped && Date.now() < deadline) {
      device.sendBinary(big);
      await sleep(10);
      dropped = device.messages.some((m) => m.type === 'viewers' && m.count === 1);
    }

    expect(dropped).toBe(true);
    expect(fast.frames.length).toBeGreaterThan(5);
    expect(fast.closed).toBeNull();

    rawSocket.resume();
    expect(await slow.waitForClose()).toEqual({ code: 4008, reason: 'too slow' });
  }, 20_000);
});

describe('sample.created events', () => {
  it('reaches viewers after a successful upload, but not after a rejected one', async () => {
    await context();
    const viewer = await ctx.viewer();
    const jpeg = await fixtureJpeg();

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=1&t=21.5&h=55.0&l=900',
      headers: { ...uploadHeaders(), 'content-type': 'image/jpeg' },
      payload: jpeg,
    });
    expect(created.statusCode).toBe(201);

    const message = await viewer.next<{ sample: Sample }>((m) => m.type === 'sample.created');
    expect(message.sample).toMatchObject({ id: 1, temperature: 21.5, ok: true });
    expect(message.sample.photoUrl).toMatch(/^\/photos\//);

    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=1&t=99&h=55&l=900',
      headers: uploadHeaders(),
    });
    expect(rejected.statusCode).toBe(400);

    // A duplicate upload id must not announce a second time either.
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=0',
      headers: uploadHeaders({ 'x-upload-id': 'retry-1' }),
    });
    expect(first.statusCode).toBe(201);
    await viewer.next((m) => m.type === 'sample.created' && (m.sample as { id: number }).id === 2);
    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=0',
      headers: uploadHeaders({ 'x-upload-id': 'retry-1' }),
    });
    expect(retry.statusCode).toBe(200);

    await sleep(150);
    expect(viewer.messages.filter((m) => m.type === 'sample.created')).toHaveLength(2);
  });
});

describe('HTTP endpoints', () => {
  it('reports realtime health alongside the database check', async () => {
    await context();
    const device = await ctx.device();
    device.send({ type: 'heartbeat', rssi: -60 });
    const viewer = await ctx.viewer();
    viewer.send({ type: 'watch', on: true });
    await sleep(80);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({
      status: 'ok',
      db: 'ok',
      disk: { photoBytes: 0, photoCount: 0 },
      ws: { viewers: 1, deviceOnline: true },
    });
  });

  it('validates the device events limit', async () => {
    await context();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/device/events?limit=0' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_LIMIT');
  });

  it('rebuilds lastSeenAt from the database after a restart', async () => {
    await context();
    const device = await ctx.device();
    device.send({ type: 'heartbeat', rssi: -61 });
    await sleep(60);
    device.socket.close();
    await sleep(120);
    const before = (await status()).lastSeenAt;
    expect(before).not.toBeNull();
    await ctx.close();

    // A fresh app against the same database restores the last contact time.
    ctx = await createRealtimeContext();
    expect((await status()).lastSeenAt).toBe(before);
  });
});

describe('graceful shutdown', () => {
  it('closes every socket with 1001 and stops its timers', async () => {
    await context();
    const device = await ctx.device();
    const viewer = await ctx.viewer();
    viewer.send({ type: 'watch', on: true });
    await sleep(60);

    const realtime = ctx.app.realtime;
    expect(realtime?.activeTimers()).toBeGreaterThan(0);
    await ctx.app.close();

    expect(await device.waitForClose()).toMatchObject({ code: 1001 });
    expect(await viewer.waitForClose()).toMatchObject({ code: 1001 });
    expect(realtime?.activeTimers()).toBe(0);
  });
});

describe('without realtime enabled', () => {
  it('publishing is a no-op and /api/device is not registered', async () => {
    const { createTestContext } = await import('./helpers.js');
    const plain = await createTestContext();
    try {
      expect(plain.app.realtime).toBeNull();
      expect(plain.app.events.hasSubscribers()).toBe(false);
      const upload = await plain.app.inject({
        method: 'POST',
        url: '/api/samples?ok=0',
        headers: uploadHeaders(),
      });
      expect(upload.statusCode).toBe(201);
      const device = await plain.app.inject({ method: 'GET', url: '/api/device' });
      expect(device.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
    // Keeps afterEach happy.
    ctx = await createRealtimeContext();
  });
});

export type { TestClient };

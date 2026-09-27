import type { DeviceLog, DeviceLogsResponse, Sample } from '@sylvan/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureJpeg, resetDatabase, uploadHeaders } from './helpers.js';
import { createRealtimeContext, type RealtimeContext } from './realtime-helpers.js';

let ctx: RealtimeContext;

async function context() {
  ctx = await createRealtimeContext();
  await resetDatabase(ctx.sql);
  return ctx;
}

afterEach(async () => {
  await ctx.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const upload = (query: string, uploadId: string, photo?: Buffer) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/samples${query}`,
    headers: {
      ...uploadHeaders({ 'x-upload-id': uploadId }),
      ...(photo ? { 'content-type': 'image/jpeg' } : {}),
    },
    ...(photo ? { payload: photo } : {}),
  });

const classify = (uploadId: string | null, body: unknown, key = true) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/samples/classification',
    headers: {
      ...(key ? uploadHeaders() : {}),
      ...(uploadId ? { 'x-upload-id': uploadId } : {}),
    },
    payload: body as Record<string, unknown>,
  });

const getLogs = async (query = '') => {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/device/logs${query}` });
  expect(res.statusCode).toBe(200);
  return res.json<DeviceLogsResponse>();
};

describe('failure reason', () => {
  it('is stored for failed samples and rejected for successful ones', async () => {
    await context();
    const failed = await upload('?ok=0&reason=dht=4,lux=ok', 'boot-1');
    expect(failed.statusCode).toBe(201);
    const sample = await ctx.app.inject({ method: 'GET', url: '/api/samples/1' });
    expect(sample.json<Sample>()).toMatchObject({
      ok: false,
      failReason: 'dht=4,lux=ok',
      classification: null,
    });

    expect((await upload('?ok=1&t=30&h=60&l=100&reason=x', 'boot-2')).statusCode).toBe(400);
    expect((await upload('?ok=0&reason=has%20space', 'boot-3')).statusCode).toBe(400);
  });
});

describe('POST /api/samples/classification', () => {
  it('sets the verdict on the uploaded sample and announces it', async () => {
    await context();
    const viewer = await ctx.viewer();
    expect((await upload('?ok=1&t=30&h=60&l=100', 'b-1', await fixtureJpeg())).statusCode).toBe(
      201,
    );

    const res = await classify('b-1', { label: 'tree', note: 'TREE (812 ms)' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Sample>()).toMatchObject({
      id: 1,
      classification: 'tree',
      classificationNote: 'TREE (812 ms)',
    });
    expect(res.json<Sample>().classifiedAt).toMatch(/Z$/);

    const message = await viewer.next<{ sample: Sample }>((m) => m.type === 'sample.updated');
    expect(message.sample).toMatchObject({ id: 1, classification: 'tree' });

    // A later verdict for the same upload replaces the earlier one.
    expect((await classify('b-1', { label: 'object' })).json<Sample>()).toMatchObject({
      classification: 'object',
      classificationNote: null,
    });
  });

  it('rejects bad requests', async () => {
    await context();
    await upload('?ok=0', 'b-1');
    expect((await classify('b-1', { label: 'tree' }, false)).statusCode).toBe(401);
    expect((await classify(null, { label: 'tree' })).statusCode).toBe(400);
    expect((await classify('b-1', { label: 'cactus' })).statusCode).toBe(400);
    expect((await classify('b-1', { label: 'tree', note: 5 })).statusCode).toBe(400);
    expect((await classify('unknown', { label: 'tree' })).statusCode).toBe(404);
  });
});

describe('device debug logs', () => {
  it('stores ESP32 and ATmega lines, lists them newest first and pushes them live', async () => {
    await context();
    const viewer = await ctx.viewer();
    const device = await ctx.device();
    device.send({ type: 'hello', fw: 'test', bootId: 'boot-7' });
    device.send({
      type: 'log',
      entries: [
        { src: 'e', lvl: 'i', ms: 100, msg: 'wifi connected' },
        { src: 'a', lvl: 'w', ms: 150, msg: 'DHT fail code=4' },
        { src: 'e', lvl: 'e', msg: 'OpenAI HTTP 401' },
      ],
    });

    const pushed = await viewer.next<{ entries: DeviceLog[] }>((m) => m.type === 'log.appended');
    expect(pushed.entries.map((entry) => entry.message)).toEqual([
      'wifi connected',
      'DHT fail code=4',
      'OpenAI HTTP 401',
    ]);

    const all = await getLogs();
    expect(all.items.map((entry) => [entry.source, entry.level, entry.message])).toEqual([
      ['esp32', 'error', 'OpenAI HTTP 401'],
      ['atmega', 'warn', 'DHT fail code=4'],
      ['esp32', 'info', 'wifi connected'],
    ]);
    expect(all.items[2]).toMatchObject({ bootId: 'boot-7', deviceMs: 100 });
    expect(all.nextBefore).toBeNull();

    expect((await getLogs('?level=warn')).items).toHaveLength(2);
    expect((await getLogs('?source=atmega')).items).toHaveLength(1);
    const page = await getLogs('?limit=2');
    expect(page.items).toHaveLength(2);
    expect(page.nextBefore).not.toBeNull();
    expect((await getLogs(`?before=${String(page.nextBefore)}`)).items).toHaveLength(1);
  });

  it('ignores malformed batches and validates the query', async () => {
    await context();
    const device = await ctx.device();
    device.send({ type: 'log', entries: [] });
    device.send({ type: 'log', entries: [{ src: 'x', lvl: 'i', msg: 'bad source' }] });
    await sleep(100);
    expect((await getLogs()).items).toHaveLength(0);

    for (const query of ['?limit=0', '?source=pc', '?level=loud', '?before=abc']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/device/logs${query}` });
      expect(res.statusCode).toBe(400);
    }
  });
});

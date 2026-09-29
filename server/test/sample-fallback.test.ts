import type { Sample } from '@sylvan/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, insertSample, resetDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDatabase(ctx.sql);
});

const get = async (id: number) =>
  (await ctx.app.inject({ method: 'GET', url: `/api/samples/${String(id)}` })).json<Sample>();

describe('fallback readings for failed samples', () => {
  it('averages the 10 successful samples nearest in time, and never touches the real fields', async () => {
    // 12 OK samples an hour apart around a failure; the 2 farthest must be left out.
    for (let hour = 0; hour < 12; hour++) {
      const far = hour === 0 || hour === 11;
      await insertSample(ctx.sql, {
        createdAt: `2026-09-10T${String(hour).padStart(2, '0')}:00:00Z`,
        temperature: far ? 99 : 30,
        humidity: far ? 1 : 60,
        lux: far ? 60000 : 400,
      });
    }
    const failed = await insertSample(ctx.sql, {
      createdAt: '2026-09-10T05:30:00Z',
      ok: false,
    });

    const sample = await get(failed);
    expect(sample).toMatchObject({ ok: false, temperature: null, humidity: null, lux: null });
    expect(sample.fallback).toEqual({ temperature: 30, humidity: 60, lux: 400 });

    const list = await ctx.app.inject({ method: 'GET', url: '/api/samples?status=failed' });
    expect(list.json<{ items: Sample[] }>().items[0]?.fallback).toEqual(sample.fallback);
  });

  it('is null for successful samples and when there is nothing to average', async () => {
    const lonely = await insertSample(ctx.sql, { createdAt: '2026-09-10T01:00:00Z', ok: false });
    expect((await get(lonely)).fallback).toBeNull();

    const ok = await insertSample(ctx.sql, { createdAt: '2026-09-10T02:00:00Z' });
    expect((await get(ok)).fallback).toBeNull();
    expect((await get(lonely)).fallback).toEqual({ temperature: 24, humidity: 60, lux: 500 });
  });
});

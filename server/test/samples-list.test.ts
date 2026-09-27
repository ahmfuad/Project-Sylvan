import type { Sample, SampleListResponse } from '@sylvan/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  fixtureJpeg,
  resetDatabase,
  uploadHeaders,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());
beforeEach(() => resetDatabase(ctx.sql));

async function insert(createdAt: string, ok: boolean, count = 1) {
  for (let i = 0; i < count; i++) {
    await ctx.sql`
      INSERT INTO samples (created_at, ok, temperature, humidity, lux)
      VALUES (${createdAt}::timestamptz, ${ok},
              ${ok ? 24.5 : null}, ${ok ? 61.2 : null}, ${ok ? 800 : null})
    `;
  }
}

async function list(query = ''): Promise<SampleListResponse> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/samples${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SampleListResponse>();
}

async function listAll(query: string): Promise<Sample[]> {
  const items: Sample[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const sep = query ? '&' : '?';
    const suffix: string = cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : '';
    const body = await list(`${query}${suffix}`);
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return items;
}

describe('GET /api/samples', () => {
  it('returns an empty page when there are no samples', async () => {
    expect(await list()).toEqual({ items: [], nextCursor: null });
  });

  it('returns typed samples newest first with numbers, ISO dates and photo URLs', async () => {
    await insert('2026-09-01T10:00:00Z', false);
    const photo = await fixtureJpeg();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/samples?ok=1&t=30.0&h=66.0&l=235',
      headers: { ...uploadHeaders(), 'content-type': 'image/jpeg' },
      payload: photo,
    });
    expect(created.statusCode).toBe(201);

    const { items, nextCursor } = await list();
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(2);
    const [newest, oldest] = items;
    expect(newest).toMatchObject({
      id: 2,
      ok: true,
      temperature: 30,
      humidity: 66,
      lux: 235,
      photoBytes: photo.length,
    });
    expect(newest?.photoUrl).toMatch(/^\/photos\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(newest?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(oldest).toEqual({
      id: 1,
      createdAt: '2026-09-01T10:00:00.000Z',
      ok: false,
      temperature: null,
      humidity: null,
      lux: null,
      photoUrl: null,
      photoBytes: null,
      failReason: null,
      classification: null,
      classificationNote: null,
      classifiedAt: null,
      ai: null,
    });
  });

  it('pages through every row exactly once, including rows with identical timestamps', async () => {
    await insert('2026-09-10T08:00:00.123456Z', true, 7);
    await insert('2026-09-10T08:00:00.123457Z', false, 3);
    for (let day = 1; day <= 13; day++) {
      await insert(`2026-09-${String(day).padStart(2, '0')}T12:00:00Z`, day % 4 !== 0);
    }

    const items = await listAll('?limit=4');
    const ids = items.map((item) => item.id);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);

    const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    expect(ids).toEqual(sorted.map((item) => item.id));
  });

  it('defaults to 50 items and caps limit at 500', async () => {
    await insert('2026-09-10T08:00:00Z', true, 55);
    const page = await list();
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();

    const tooMany = await ctx.app.inject({ method: 'GET', url: '/api/samples?limit=501' });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<{ error: { code: string } }>().error.code).toBe('INVALID_LIMIT');
  });

  it('filters by status', async () => {
    await insert('2026-09-10T08:00:00Z', true, 3);
    await insert('2026-09-10T09:00:00Z', false, 2);

    expect((await listAll('?status=all&limit=2')).length).toBe(5);
    const ok = await listAll('?status=ok&limit=2');
    expect(ok.map((item) => item.ok)).toEqual([true, true, true]);
    const failed = await listAll('?status=failed&limit=1');
    expect(failed.map((item) => item.ok)).toEqual([false, false]);
  });

  it('filters by date range: from is inclusive, a plain to date includes that whole day', async () => {
    await insert('2026-09-09T23:59:59Z', true);
    await insert('2026-09-10T00:00:00Z', true);
    await insert('2026-09-11T23:59:59.999Z', true);
    await insert('2026-09-12T00:00:00Z', true);

    const days = await list('?from=2026-09-10&to=2026-09-11');
    expect(days.items.map((item) => item.createdAt)).toEqual([
      '2026-09-11T23:59:59.999Z',
      '2026-09-10T00:00:00.000Z',
    ]);

    const exact = await list('?from=2026-09-10T00:00:00Z&to=2026-09-12T00:00:00Z');
    expect(exact.items).toHaveLength(3);

    const combined = await listAll('?from=2026-09-10&status=ok&limit=1');
    expect(combined).toHaveLength(3);
  });

  it('filters by photo presence', async () => {
    await insert('2026-09-10T08:00:00Z', true, 2);
    await ctx.sql`UPDATE samples SET photo_key = '2026/09/x.jpg', photo_bytes = 10 WHERE id = 1`;

    expect((await list('?hasPhoto=true')).items.map((item) => item.id)).toEqual([1]);
    expect((await list('?hasPhoto=false')).items.map((item) => item.id)).toEqual([2]);
    expect((await list()).items).toHaveLength(2);
  });

  it('pages oldest first with order=asc', async () => {
    await insert('2026-09-10T08:00:00Z', true, 4);
    await insert('2026-09-09T08:00:00Z', false, 3);

    const items = await listAll('?order=asc&limit=2');
    expect(items.map((item) => item.id)).toEqual([5, 6, 7, 1, 2, 3, 4]);
  });

  it.each([
    ['?hasPhoto=yes', 'INVALID_HAS_PHOTO'],
    ['?order=newest', 'INVALID_ORDER'],
    ['?status=broken', 'INVALID_STATUS'],
    ['?limit=0', 'INVALID_LIMIT'],
    ['?limit=abc', 'INVALID_LIMIT'],
    ['?cursor=not-a-cursor', 'INVALID_CURSOR'],
    ['?from=yesterday', 'INVALID_DATE'],
    ['?to=2026-13-45', 'INVALID_DATE'],
    ['?from=2026-09-12&to=2026-09-10', 'INVALID_DATE'],
  ])('rejects %s with %s', async (query, code) => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/samples${query}` });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(code);
  });
});

describe('GET /api/samples/:id', () => {
  it('returns one sample', async () => {
    await insert('2026-09-10T08:00:00Z', true);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/samples/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Sample>()).toMatchObject({ id: 1, ok: true, temperature: 24.5, lux: 800 });
  });

  it.each(['999', 'abc', '0', '-1', '1.5', '99999999999999999999'])(
    'returns 404 for %s',
    async (id) => {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/samples/${id}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Sample not found' } });
    },
  );
});

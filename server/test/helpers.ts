import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppConfig } from '../src/app.js';
import { createSql, type Sql } from '../src/db/client.js';
import { testDatabaseUrl } from './database.js';

export const DEVICE_KEY = 'test-device-key-0123456789abcdef0123456789abcdef';
export const MAX_PHOTO_BYTES = 20_000;

export const fixtureJpeg = () => readFile(new URL('./fixtures/sample.jpg', import.meta.url));

export interface TestContext {
  app: FastifyInstance;
  sql: Sql;
  /** The PHOTO_DIR for this app; its parent is a temp directory removed on close. */
  photoDir: string;
  tempRoot: string;
  logs: string[];
  close(): Promise<void>;
}

export async function createTestContext(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'sylvan-test-'));
  const photoDir = path.join(tempRoot, 'photos');
  const sql = createSql(testDatabaseUrl());
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });

  const app = await buildApp({
    sql,
    logStream,
    config: {
      deviceKey: DEVICE_KEY,
      photoDir,
      maxPhotoBytes: MAX_PHOTO_BYTES,
      servePhotos: true,
      trustProxy: ['127.0.0.1'],
      logLevel: 'info',
      displayTimezone: 'Asia/Dhaka',
      publicBaseUrl: 'https://sylvan.example.com',
      ...overrides,
    },
  });
  await app.ready();

  return {
    app,
    sql,
    photoDir,
    tempRoot,
    logs,
    async close() {
      await app.close();
      await sql.end({ timeout: 5 });
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function resetDatabase(sql: Sql) {
  await sql`TRUNCATE samples, device_events, device_logs RESTART IDENTITY`;
}

/** Lists every file (including temp files) below a directory, relative to it. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function uploadHeaders(extra: Record<string, string> = {}) {
  return { 'x-device-key': DEVICE_KEY, ...extra };
}

export interface InsertSample {
  createdAt: string;
  ok?: boolean;
  temperature?: number;
  humidity?: number;
  lux?: number;
  photoKey?: string | null;
}

/** Inserts a sample directly, bypassing the upload API, and returns its id. */
export async function insertSample(sql: Sql, sample: InsertSample): Promise<number> {
  const ok = sample.ok ?? true;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO samples (created_at, ok, temperature, humidity, lux, photo_key, photo_bytes)
    VALUES (
      ${sample.createdAt}::timestamptz, ${ok},
      ${ok ? (sample.temperature ?? 24) : null},
      ${ok ? (sample.humidity ?? 60) : null},
      ${ok ? (sample.lux ?? 500) : null},
      ${sample.photoKey ?? null},
      ${sample.photoKey ? 1000 : null}
    )
    RETURNING id
  `;
  return Number(row?.id);
}

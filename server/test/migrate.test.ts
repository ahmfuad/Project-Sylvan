import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { testDatabaseUrl } from './database.js';

let sql: Sql;

beforeAll(() => {
  sql = createSql(testDatabaseUrl());
});
afterAll(() => sql.end({ timeout: 5 }));

describe('runMigrations', () => {
  it('is safe to run repeatedly', async () => {
    // Global setup already applied everything.
    expect(await runMigrations(sql)).toEqual([]);
    expect(await Promise.all([runMigrations(sql), runMigrations(sql)])).toEqual([[], []]);
    const versions = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
    expect(versions.map((row) => row.version)).toEqual([
      '001_create_samples.sql',
      '002_create_device_events.sql',
      '003_classification_and_device_logs.sql',
      '004_server_ai_classification.sql',
    ]);
  });

  it('rolls back a failing migration and does not record it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sylvan-migrations-'));
    try {
      await writeFile(
        path.join(dir, '900_broken.sql'),
        'CREATE TABLE migration_probe (id int); SELECT no_such_function();',
      );
      await expect(runMigrations(sql, undefined, dir)).rejects.toThrow(/no_such_function/);
      const [probe] = await sql`SELECT to_regclass('migration_probe') AS table_name`;
      expect(probe?.table_name).toBeNull();
      const recorded = await sql`SELECT 1 FROM schema_migrations WHERE version = '900_broken.sql'`;
      expect(recorded).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces the readings/status check constraint', async () => {
    await expect(sql`INSERT INTO samples (ok) VALUES (true)`).rejects.toThrow(
      /readings_match_status/,
    );
    await expect(
      sql`INSERT INTO samples (ok, temperature, humidity, lux) VALUES (false, 1, 1, 1)`,
    ).rejects.toThrow(/readings_match_status/);
  });
});

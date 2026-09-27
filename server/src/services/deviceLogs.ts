import type {
  DeviceLog,
  DeviceLogLevel,
  DeviceLogSource,
  DeviceLogsResponse,
} from '@sylvan/shared';
import type { Sql } from '../db/client.js';

export interface NewDeviceLog {
  source: DeviceLogSource;
  level: DeviceLogLevel;
  deviceMs: number | null;
  message: string;
}

export interface DeviceLogQuery {
  limit: number;
  before: number | null;
  source: DeviceLogSource | null;
  /** Minimum level. */
  level: DeviceLogLevel | null;
  bootId: string | null;
}

interface LogRow {
  id: string;
  received_at: Date;
  source: DeviceLogSource;
  level: DeviceLogLevel;
  boot_id: string | null;
  device_ms: string | null;
  message: string;
}

export interface DeviceLogStore {
  /** Stores a batch without blocking the caller; failures are reported, never thrown. */
  append(bootId: string | null, entries: NewDeviceLog[]): void;
  list(query: DeviceLogQuery): Promise<DeviceLogsResponse>;
  /** Deletes lines older than the retention period, then the oldest beyond the row cap. */
  prune(): Promise<void>;
  /** Waits for in-flight writes (used during shutdown before the pool closes). */
  flush(): Promise<void>;
}

const LEVELS: DeviceLogLevel[] = ['debug', 'info', 'warn', 'error'];

const toLog = (row: LogRow): DeviceLog => ({
  id: Number(row.id),
  receivedAt: row.received_at.toISOString(),
  source: row.source,
  level: row.level,
  bootId: row.boot_id,
  deviceMs: row.device_ms === null ? null : Number(row.device_ms),
  message: row.message,
});

export function createDeviceLogStore(deps: {
  sql: Sql;
  onStored: (entries: DeviceLog[]) => void;
  onError: (error: unknown) => void;
  onDropped: (count: number) => void;
  /** Lines accepted per minute; a stuck logging loop on the device must not flood the table. */
  maxPerMinute?: number;
  retentionDays?: number;
  maxRows?: number;
  now?: () => number;
}): DeviceLogStore {
  const { sql } = deps;
  const maxPerMinute = deps.maxPerMinute ?? 1200;
  const retentionDays = deps.retentionDays ?? 14;
  const maxRows = deps.maxRows ?? 100_000;
  const now = deps.now ?? Date.now;
  let windowStart = now();
  let windowCount = 0;
  const pending = new Set<Promise<unknown>>();

  return {
    append(bootId, entries) {
      if (now() - windowStart >= 60_000) {
        windowStart = now();
        windowCount = 0;
      }
      const room = Math.max(0, maxPerMinute - windowCount);
      const accepted = entries.slice(0, room);
      if (accepted.length < entries.length) deps.onDropped(entries.length - accepted.length);
      if (accepted.length === 0) return;
      windowCount += accepted.length;

      const rows = accepted.map((entry) => ({
        source: entry.source,
        level: entry.level,
        boot_id: bootId,
        device_ms: entry.deviceMs,
        message: entry.message,
      }));
      const write = sql<LogRow[]>`
        INSERT INTO device_logs ${sql(rows, 'source', 'level', 'boot_id', 'device_ms', 'message')}
        RETURNING id, received_at, source, level, boot_id, device_ms, message
      `.then(
        (inserted) => {
          deps.onStored(inserted.map(toLog));
        },
        (error: unknown) => {
          deps.onError(error);
        },
      );
      pending.add(write);
      void write.finally(() => pending.delete(write));
    },

    async list({ limit, before, source, level, bootId }) {
      const minLevel = level ? LEVELS.slice(LEVELS.indexOf(level)) : null;
      const rows = await sql<LogRow[]>`
        SELECT id, received_at, source, level, boot_id, device_ms, message
        FROM device_logs
        WHERE TRUE
          ${before === null ? sql`` : sql`AND id < ${before}`}
          ${source === null ? sql`` : sql`AND source = ${source}`}
          ${minLevel === null ? sql`` : sql`AND level IN ${sql(minLevel)}`}
          ${bootId === null ? sql`` : sql`AND boot_id = ${bootId}`}
        ORDER BY id DESC
        LIMIT ${limit + 1}
      `;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toLog),
        nextBefore: rows.length > limit && last ? Number(last.id) : null,
      };
    },

    async prune() {
      await sql`
        DELETE FROM device_logs
        WHERE received_at < now() - make_interval(days => ${retentionDays})
      `;
      await sql`
        DELETE FROM device_logs
        WHERE id <= (SELECT id FROM device_logs ORDER BY id DESC OFFSET ${maxRows} LIMIT 1)
      `;
    },

    async flush() {
      await Promise.all([...pending]);
    },
  };
}

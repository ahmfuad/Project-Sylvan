import type {
  DeviceEventsResponse,
  DeviceLogLevel,
  DeviceLogSource,
  DeviceLogsResponse,
  DeviceStatus,
} from '@sylvan/shared';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../lib/errors.js';
import type { DeviceEventStore } from '../services/deviceEvents.js';
import type { DeviceLogQuery, DeviceLogStore } from '../services/deviceLogs.js';

const SOURCES: DeviceLogSource[] = ['esp32', 'atmega'];
const LEVELS: DeviceLogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseLogQuery(query: Record<string, unknown>): DeviceLogQuery {
  const bad = (code: string, message: string): never => {
    throw new AppError(400, code, message);
  };
  let limit = 200;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d{1,3}$/.test(query.limit)) {
      bad('INVALID_LIMIT', 'limit must be a whole number between 1 and 500');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > 500) bad('INVALID_LIMIT', 'limit must be between 1 and 500');
  }
  let before: number | null = null;
  if (query.before !== undefined) {
    if (typeof query.before !== 'string' || !/^[1-9]\d{0,15}$/.test(query.before)) {
      bad('INVALID_BEFORE', 'before must be a log id');
    }
    before = Number(query.before);
  }
  const source = query.source ?? null;
  if (source !== null && !SOURCES.includes(source as DeviceLogSource)) {
    bad('INVALID_SOURCE', 'source must be esp32 or atmega');
  }
  const level = query.level ?? null;
  if (level !== null && !LEVELS.includes(level as DeviceLogLevel)) {
    bad('INVALID_LEVEL', 'level must be debug, info, warn or error');
  }
  const bootId = query.bootId ?? null;
  if (bootId !== null && (typeof bootId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(bootId))) {
    bad('INVALID_BOOT_ID', 'bootId is not valid');
  }
  return {
    limit,
    before,
    source: source as DeviceLogSource | null,
    level: level as DeviceLogLevel | null,
    bootId: bootId as string | null,
  };
}

/**
 * Public, read-only device endpoints. `GET /api/device` lets pages show status when WebSockets
 * are blocked. The event log is public too: it holds only times, event types, signal, uptime,
 * firmware, boot id and close codes, all of which the live status already exposes. No IP
 * addresses or keys are stored.
 */
export const deviceRoutes: FastifyPluginAsync<{
  getStatus: () => DeviceStatus;
  events: DeviceEventStore;
  logs: DeviceLogStore;
}> = async (app, { getStatus, events, logs }) => {
  app.get('/api/device', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return getStatus();
  });

  app.get('/api/device/events', async (request) => {
    const { limit: raw } = request.query as { limit?: unknown };
    let limit = 20;
    if (raw !== undefined) {
      if (
        typeof raw !== 'string' ||
        !/^\d{1,3}$/.test(raw) ||
        Number(raw) < 1 ||
        Number(raw) > 100
      ) {
        throw new AppError(400, 'INVALID_LIMIT', 'limit must be a whole number between 1 and 100');
      }
      limit = Number(raw);
    }
    return { items: await events.recent(limit) } satisfies DeviceEventsResponse;
  });

  /** Debug trail from the rover, newest first. Public like the event log: it holds no secrets. */
  app.get('/api/device/logs', async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    return (await logs.list(
      parseLogQuery(request.query as Record<string, unknown>),
    )) satisfies DeviceLogsResponse;
  });
};

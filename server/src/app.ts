import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Sql } from './db/client.js';
import { AppError, errorBody } from './lib/errors.js';
import { RATE_LIMITS, rateLimitPluginOptions } from './lib/rateLimits.js';
import { createRealtime, type Realtime, type RealtimeConfig } from './realtime/index.js';
import { deviceRoutes } from './routes/device.js';
import { exploreRoutes } from './routes/explore.js';
import { healthRoutes } from './routes/health.js';
import { photoRoutes } from './routes/photos.js';
import { exportRoutes } from './routes/export.js';
import { sampleRoutes } from './routes/samples.js';
import { statsRoutes } from './routes/stats.js';
import { createDeviceEventStore } from './services/deviceEvents.js';
import { createDeviceLogStore } from './services/deviceLogs.js';
import { createDiskUsageReporter } from './services/diskUsage.js';
import { createEventBus, type EventBus } from './services/events.js';
import { createExploreService } from './services/explore.js';
import { createExportService } from './services/export.js';
import { createPhotoStorage } from './services/photoStorage.js';
import { createSamplesService } from './services/samples.js';
import { createStatsService } from './services/stats.js';
import { createTimezoneResolver } from './services/timezones.js';

export type AppConfig = Pick<
  Config,
  'deviceKey' | 'photoDir' | 'maxPhotoBytes' | 'servePhotos' | 'trustProxy' | 'logLevel'
> &
  Partial<Pick<Config, 'displayTimezone' | 'publicBaseUrl'>> & {
    /** Enables the WebSocket channels. Off unless set, so HTTP-only tests are unaffected. */
    realtime?: RealtimeConfig;
    /**
     * Enables rate limiting and other production-only hardening (helmet, body limits and
     * timeouts are always on). Off unless set, so existing tests firing many rapid requests are
     * unaffected; the real server always turns this on (see index.ts).
     */
    hardening?: boolean;
    /** Test-only override so downsampling can be exercised without inserting thousands of rows. */
    exploreMaxPoints?: number;
  };

declare module 'fastify' {
  interface FastifyInstance {
    events: EventBus;
    realtime: Realtime | null;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  sql: Sql;
  /** Destination for logs; tests pass a stream to inspect them. Defaults to stdout. */
  logStream?: NodeJS.WritableStream;
}

const FRAMEWORK_ERRORS: Record<string, { statusCode: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    statusCode: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Photo exceeds the maximum allowed size',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    statusCode: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Unsupported content type',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    statusCode: 400,
    code: 'INVALID_CONTENT_LENGTH',
    message: 'Request body length does not match Content-Length',
  },
};

export async function buildApp({
  config,
  sql,
  logStream,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers["x-device-key"]', 'headers["x-device-key"]'],
        censor: '[redacted]',
      },
      ...(logStream ? { stream: logStream } : {}),
    },
    // Only honour X-Forwarded-* from the local reverse proxy.
    trustProxy: config.trustProxy,
    // Small: only the JSON/query routes use this. The photo upload route sets its own, larger
    // bodyLimit (config.maxPhotoBytes) at the route level, overriding this default.
    bodyLimit: 16 * 1024,
    // A slow or stalled client should not be able to hold a connection open indefinitely. The CSV
    // export can legitimately take a few seconds for a large range, so this stays generous.
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    return503OnClosing: true,
    requestIdHeader: false,
  });

  await app.register(helmet, {
    // The app currently serves only JSON/CSV/photo responses (the SPA is served separately by
    // nginx in production, or by Vite in development), but the same policy is documented for
    // nginx to apply to the built frontend too — see README "Security headers".
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        // React/Recharts/Radix set inline `style` attributes; there is no inline <style> block
        // or inline <script>, so this does not weaken script execution protection.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    // TLS is terminated by nginx in production (Phase 5), which is the right place to set HSTS;
    // the app never knows for certain whether the request it saw arrived over HTTPS.
    hsts: false,
    // Matches the CSP's frame-ancestors 'none' above: never embeddable, not even same-origin.
    frameguard: { action: 'deny' },
  });

  if (config.hardening) {
    // Registered as the global default (the public read endpoints), with specific routes
    // overriding or exempting themselves via their own `config.rateLimit` (see health.ts,
    // export.ts) or, for the upload route's two-bucket policy, the `app.rateLimit()` decorator
    // used directly in samples.ts.
    await app.register(rateLimit, {
      ...rateLimitPluginOptions,
      global: true,
      max: RATE_LIMITS.publicRead.max,
      timeWindow: RATE_LIMITS.publicRead.timeWindow,
    });
  }

  const events = createEventBus((error) => {
    app.log.error({ err: error }, 'event handler failed');
  });
  app.decorate('events', events);

  const storage = createPhotoStorage(config.photoDir);
  const samples = createSamplesService({
    sql,
    storage,
    onCleanupError: (error, key) => {
      app.log.error({ err: error, photoKey: key }, 'failed to remove orphan photo');
    },
  });

  const timezones = createTimezoneResolver(sql, config.displayTimezone ?? 'UTC');
  const stats = createStatsService({ sql, samples, timezones });
  const explore = createExploreService({
    sql,
    timezones,
    ...(config.exploreMaxPoints !== undefined ? { maxPoints: config.exploreMaxPoints } : {}),
  });
  const exporter = createExportService({
    sql,
    timezones,
    publicBaseUrl: config.publicBaseUrl ?? '',
  });

  const disk = createDiskUsageReporter(config.photoDir, {
    onError: (error) => {
      app.log.error({ err: error }, 'could not measure photo directory usage');
    },
  });
  disk.start();
  app.addHook('onClose', () => {
    disk.stop();
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }

    const known = error.code ? FRAMEWORK_ERRORS[error.code] : undefined;
    if (known) {
      return reply.code(known.statusCode).send(errorBody(known.code, known.message));
    }

    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send(errorBody('BAD_REQUEST', 'The request could not be processed'));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(errorBody('NOT_FOUND', 'Not found'));
  });

  let realtime: Realtime | null = null;
  if (config.realtime) {
    const deviceEvents = createDeviceEventStore({
      sql,
      onError: (error) => {
        app.log.error({ err: error }, 'could not record device event');
      },
      onDropped: (type) => {
        app.log.warn({ type }, 'device event rate limit reached; event not recorded');
      },
    });
    const deviceLogs = createDeviceLogStore({
      sql,
      onStored: (entries) => {
        events.publish({ type: 'log.appended', entries });
      },
      onError: (error) => {
        app.log.error({ err: error }, 'could not store device log lines');
      },
      onDropped: (count) => {
        app.log.warn({ count }, 'device log rate limit reached; lines dropped');
      },
    });
    const prune = () => {
      deviceLogs.prune().catch((error: unknown) => {
        app.log.error({ err: error }, 'could not prune device logs');
      });
    };
    prune();
    const pruneTimer = setInterval(prune, 60 * 60 * 1000);
    pruneTimer.unref();
    app.addHook('onClose', () => {
      clearInterval(pruneTimer);
    });
    const viewerConnectionLimit = config.hardening
      ? (config.realtime.maxNewViewerConnectionsPerMinute ?? RATE_LIMITS.viewerConnectionsPerMinute)
      : config.realtime.maxNewViewerConnectionsPerMinute;
    realtime = createRealtime({
      server: app.server,
      config: {
        ...config.realtime,
        trustProxy: config.trustProxy,
        ...(viewerConnectionLimit !== undefined
          ? { maxNewViewerConnectionsPerMinute: viewerConnectionLimit }
          : {}),
      },
      bus: events,
      events: deviceEvents,
      logs: deviceLogs,
      deviceKey: config.deviceKey,
      log: app.log,
    });
    await realtime.init();
    const active = realtime;
    // Close sockets before the HTTP server stops, or open connections would hold it open.
    app.addHook('preClose', async () => {
      await active.close();
    });
    await app.register(deviceRoutes, {
      getStatus: () => active.status(),
      events: deviceEvents,
      logs: deviceLogs,
    });
  }
  app.decorate('realtime', realtime);

  const active = realtime;
  await app.register(healthRoutes, {
    sql,
    disk,
    ...(active ? { realtimeHealth: () => active.health() } : {}),
  });
  await app.register(sampleRoutes, {
    samples,
    events,
    deviceKey: config.deviceKey,
    maxPhotoBytes: config.maxPhotoBytes,
    hardening: Boolean(config.hardening),
  });
  await app.register(statsRoutes, { stats });
  await app.register(exploreRoutes, { explore });
  await app.register(exportRoutes, { exporter });
  if (config.servePhotos) {
    await app.register(photoRoutes, { photoDir: storage.root });
  }

  return app;
}

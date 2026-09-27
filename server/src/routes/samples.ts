import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isValidDeviceKey } from '../lib/auth.js';
import { AppError, errorBody } from '../lib/errors.js';
import { RATE_LIMITS, hashDeviceKey } from '../lib/rateLimits.js';
import {
  parseClassificationBody,
  parseListQuery,
  parseSampleId,
  parseUploadId,
  parseUploadQuery,
  type Readings,
} from '../lib/validation.js';
import { isJpeg } from '../services/photoStorage.js';
import type { EventBus } from '../services/events.js';
import type { SamplesService } from '../services/samples.js';

interface SampleRoutesOptions {
  samples: SamplesService;
  events: EventBus;
  deviceKey: string;
  maxPhotoBytes: number;
  /** Off by default so existing fast-firing tests are unaffected; the real server turns it on. */
  hardening?: boolean;
  /** Called after a new sample with a photo is stored (wakes the classification worker). */
  onPhotoStored?: () => void;
}

interface ParsedUpload {
  readings: Readings | null;
  uploadId: string | null;
  failReason: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    sampleUpload: ParsedUpload | null;
  }
}

/** `POST /api/samples`, the fixed contract used by the ESP32-CAM firmware. */
const uploadRoute: FastifyPluginAsync<SampleRoutesOptions> = async (app, options) => {
  const { samples, events, deviceKey, maxPhotoBytes, hardening, onPhotoStored } = options;

  app.decorateRequest('sampleUpload', null);

  // Scoped to this plugin: the upload route accepts only raw JPEG bodies (or no body at all).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'image/jpeg',
    { parseAs: 'buffer', bodyLimit: maxPhotoBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addContentTypeParser(
    '*',
    async (_request: FastifyRequest, payload: NodeJS.ReadableStream) => {
      for await (const chunk of payload) {
        if (chunk.length > 0) {
          throw new AppError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Photo body must be sent as image/jpeg',
          );
        }
      }
      return undefined;
    },
  );

  // Two separate budgets: a valid key is limited by the key itself (never by IP, since the
  // rover is behind NAT and may share an address with other devices); a wrong or missing key is
  // limited by IP, to slow down key-guessing without needing to know the key first.
  const rateLimitGate = hardening
    ? (() => {
        const byKey = app.rateLimit({
          ...RATE_LIMITS.uploadByKey,
          keyGenerator: (request) => {
            const key = request.headers['x-device-key'];
            return typeof key === 'string' ? `upload-key:${hashDeviceKey(key)}` : 'upload-key:none';
          },
        });
        const byIp = app.rateLimit(RATE_LIMITS.uploadFailedAuth);
        return async (request: FastifyRequest, reply: FastifyReply) => {
          if (isValidDeviceKey(request.headers['x-device-key'], deviceKey)) {
            await byKey.call(app, request, reply);
          } else {
            await byIp.call(app, request, reply);
          }
        };
      })()
    : null;

  // Auth, query validation and the idempotency lookup run before the body is read, so a
  // rejected or duplicate request never spends time or memory receiving a photo.
  const authenticate = async (request: FastifyRequest) => {
    if (!isValidDeviceKey(request.headers['x-device-key'], deviceKey)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid device key');
    }
  };

  const validate = async (request: FastifyRequest) => {
    const { readings, failReason } = parseUploadQuery(request.query as Record<string, unknown>);
    const uploadId = parseUploadId(request.headers['x-upload-id']);
    request.sampleUpload = { readings, uploadId, failReason };
  };

  const replayDuplicate = async (request: FastifyRequest, reply: FastifyReply) => {
    const uploadId = request.sampleUpload?.uploadId;
    if (!uploadId) return;
    const existing = await samples.findUpload(uploadId);
    if (!existing) return;
    request.log.info(
      { uploadId, sampleId: existing.id },
      'duplicate upload id, returning existing',
    );
    return reply.code(200).send(existing);
  };

  app.post(
    '/api/samples',
    {
      bodyLimit: maxPhotoBytes,
      // The global rate-limit default does not apply here; this route always uses its own
      // two-bucket policy above (or none at all when hardening is off).
      config: { rateLimit: false },
      onRequest: [
        ...(rateLimitGate ? [rateLimitGate] : []),
        authenticate,
        validate,
        replayDuplicate,
      ],
    },
    async (request, reply) => {
      const upload = request.sampleUpload;
      if (!upload) throw new Error('Upload was not validated');

      const body = request.body;
      let photo: Buffer | null = null;
      if (Buffer.isBuffer(body) && body.length > 0) {
        if (!isJpeg(body)) {
          throw new AppError(
            400,
            'INVALID_PHOTO',
            'Photo body is not a JPEG (must start with FF D8)',
          );
        }
        photo = body;
      }

      const result = await samples.create({ ...upload, photo });
      request.log.info(
        { sampleId: result.response.id, created: result.created, photoBytes: photo?.length ?? 0 },
        result.created ? 'sample stored' : 'duplicate upload id resolved after race',
      );
      if (result.created && result.response.photo) onPhotoStored?.();
      if (result.created && events.hasSubscribers()) {
        // The insert has committed; announce it without delaying the device's response.
        void samples.get(String(result.response.id)).then(
          (sample) => {
            if (sample) events.publish({ type: 'sample.created', sample });
          },
          (error: unknown) => {
            request.log.error({ err: error }, 'could not publish sample.created');
          },
        );
      }
      return reply.code(result.created ? 201 : 200).send(result.response);
    },
  );
};

/**
 * `POST /api/samples/classification`: the ESP32 reports the OpenAI verdict for a sample it has
 * already uploaded, identified by the same `X-Upload-Id`. Kept in its own plugin because the
 * upload plugin replaces the JSON body parser with a JPEG-only one.
 */
const classificationRoute: FastifyPluginAsync<SampleRoutesOptions> = async (app, options) => {
  const { samples, events, deviceKey, hardening } = options;

  app.post(
    '/api/samples/classification',
    {
      config: hardening
        ? {
            rateLimit: {
              ...RATE_LIMITS.uploadByKey,
              keyGenerator: (request: FastifyRequest) => {
                const key = request.headers['x-device-key'];
                return typeof key === 'string'
                  ? `classify-key:${hashDeviceKey(key)}`
                  : `classify-ip:${request.ip}`;
              },
            },
          }
        : { rateLimit: false },
    },
    async (request, reply) => {
      if (!isValidDeviceKey(request.headers['x-device-key'], deviceKey)) {
        throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid device key');
      }
      const uploadId = parseUploadId(request.headers['x-upload-id']);
      if (uploadId === null) {
        throw new AppError(400, 'MISSING_UPLOAD_ID', 'X-Upload-Id header is required');
      }
      const { label, note } = parseClassificationBody(request.body);
      const sample = await samples.classify(uploadId, label, note);
      if (!sample) {
        return reply
          .code(404)
          .send(errorBody('NOT_FOUND', 'No sample with this upload id (upload it first)'));
      }
      request.log.info({ sampleId: sample.id, label }, 'sample classified');
      events.publish({ type: 'sample.updated', sample });
      return sample;
    },
  );
};

const readRoutes: FastifyPluginAsync<{ samples: SamplesService }> = async (app, { samples }) => {
  app.get('/api/samples', async (request) => {
    return samples.list(parseListQuery(request.query as Record<string, unknown>));
  });

  app.get<{ Params: { id: string } }>('/api/samples/:id', async (request, reply) => {
    const id = parseSampleId(request.params.id);
    const sample = id === null ? null : await samples.get(id);
    if (!sample) return reply.code(404).send(errorBody('NOT_FOUND', 'Sample not found'));
    return sample;
  });

  app.get<{ Params: { id: string } }>('/api/samples/:id/neighbors', async (request, reply) => {
    const id = parseSampleId(request.params.id);
    const neighbors = id === null ? null : await samples.neighbors(id);
    if (!neighbors) return reply.code(404).send(errorBody('NOT_FOUND', 'Sample not found'));
    return neighbors;
  });
};

export const sampleRoutes: FastifyPluginAsync<SampleRoutesOptions> = async (app, options) => {
  await app.register(uploadRoute, options);
  await app.register(classificationRoute, options);
  await app.register(readRoutes, { samples: options.samples });
};

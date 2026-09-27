import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLACEHOLDER_DEVICE_KEY = 'generate-with-openssl-rand-hex-32';

/**
 * Loads `.env.local` then `.env` from the repository root when they exist. Variables that are
 * already set (for example by Docker Compose) are never overwritten, so the first source wins.
 */
export function loadEnvFiles(root = REPO_ROOT): void {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const booleanString = z
  .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
  .transform((value) => value === 'true' || value === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    HOST: z.string().min(1).default('127.0.0.1'),
    DATABASE_URL: z
      .string({ error: 'is required' })
      .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// connection URL'),
    DEVICE_KEY: z
      .string({ error: 'is required' })
      .min(32, 'must be at least 32 characters (generate one with `openssl rand -hex 32`)')
      .refine(
        (key) => key !== PLACEHOLDER_DEVICE_KEY,
        'is still the placeholder from .env.example',
      ),
    PHOTO_DIR: z.string({ error: 'is required' }).min(1),
    MAX_PHOTO_BYTES: z.coerce.number().int().min(1024).max(10_000_000).default(500_000),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }),
    SERVE_PHOTOS: booleanString.optional(),
    TRUST_PROXY: z.string().default('127.0.0.1,::1'),
    DISPLAY_TIMEZONE: z
      .string()
      .default('UTC')
      .refine(isValidTimezone, 'must be an IANA timezone such as Asia/Dhaka'),
    DEVICE_TIMEOUT_S: z.coerce.number().int().min(5).max(600).default(30),
    MAX_FRAME_BYTES: z.coerce.number().int().min(1024).max(2_000_000).default(200_000),
    SLOW_VIEWER_BYTES: z.coerce.number().int().min(1024).max(10_000_000).default(200_000),
    STREAM_TARGET_FPS: z.coerce.number().int().min(1).max(10).default(5),
    STREAM_JPEG_QUALITY: z.coerce.number().int().min(10).max(100).default(65),
    MAX_VIEWERS: z.coerce.number().int().min(1).max(1000).default(50),
    WS_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1024).max(4_000_000).default(262_144),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Optional: enables the server's own photo classification. */
    OPENAI_API_KEY: z.string().min(20, 'does not look like an OpenAI API key').optional(),
    /** Must return logprobs for the confidence score (gpt-4.1 / gpt-4o families). */
    OPENAI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  })
  .refine((env) => env.WS_MAX_MESSAGE_BYTES >= env.MAX_FRAME_BYTES, {
    path: ['WS_MAX_MESSAGE_BYTES'],
    message: 'must be at least MAX_FRAME_BYTES',
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    deviceKey: env.DEVICE_KEY,
    photoDir: path.resolve(REPO_ROOT, env.PHOTO_DIR),
    maxPhotoBytes: env.MAX_PHOTO_BYTES,
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    servePhotos: env.SERVE_PHOTOS ?? env.NODE_ENV === 'development',
    trustProxy: env.TRUST_PROXY.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    displayTimezone: env.DISPLAY_TIMEZONE,
    logLevel: env.LOG_LEVEL,
    openai: env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL } : null,
    realtime: {
      deviceTimeoutMs: env.DEVICE_TIMEOUT_S * 1000,
      maxFrameBytes: env.MAX_FRAME_BYTES,
      slowViewerBytes: env.SLOW_VIEWER_BYTES,
      targetFps: env.STREAM_TARGET_FPS,
      jpegQuality: env.STREAM_JPEG_QUALITY,
      maxViewers: env.MAX_VIEWERS,
      maxMessageBytes: env.WS_MAX_MESSAGE_BYTES,
    },
  }));

export type Config = z.output<typeof envSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates the environment. The error message names variables but never includes their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trimmed = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === '' ? undefined : value?.trim()]),
  );
  const result = envSchema.safeParse(trimmed);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || 'environment';
    return `  - ${name}: ${issue.message}`;
  });
  throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
}

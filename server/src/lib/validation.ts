import type { SampleOrder, SampleStatusFilter } from '@sylvan/shared';
import { AppError } from './errors.js';

export interface Readings {
  temperature: number;
  humidity: number;
  lux: number;
}

export type UploadQuery =
  | { ok: true; readings: Readings; failReason: null }
  | { ok: false; readings: null; failReason: string | null };

type Query = Record<string, unknown>;

const DECIMAL = /^-?\d{1,3}(\.\d+)?$/;
const UNSIGNED_INTEGER = /^\d{1,5}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Short machine-written cause, e.g. `dht=4,lux=ok`. */
const FAIL_REASON = /^[A-Za-z0-9_=,:.-]{1,64}$/;

function invalid(code: string, message: string): never {
  throw new AppError(400, code, message);
}

function readDecimal(
  query: Query,
  key: string,
  code: string,
  label: string,
  min: number,
  max: number,
) {
  const raw = query[key];
  if (raw === undefined) invalid(code, `${key} (${label}) is required when ok=1`);
  if (typeof raw !== 'string' || !DECIMAL.test(raw)) {
    invalid(code, `${key} (${label}) must be a number`);
  }
  // Stored as NUMERIC(5,1); round here so the stored and returned values agree.
  const value = Math.round(Number(raw) * 10) / 10;
  if (value < min || value > max)
    invalid(code, `${key} (${label}) must be between ${min} and ${max}`);
  return value;
}

/** Validates the query string of `POST /api/samples`, checking fields in a fixed order. */
export function parseUploadQuery(query: Query): UploadQuery {
  const ok = query.ok;
  if (ok !== '0' && ok !== '1') invalid('INVALID_OK', 'ok must be 0 or 1');

  if (ok === '0') {
    const present = ['t', 'h', 'l'].filter((key) => query[key] !== undefined);
    if (present.length > 0) {
      invalid('READINGS_NOT_ALLOWED', `ok=0 must not include readings (got ${present.join(', ')})`);
    }
    const reason = query.reason;
    if (reason !== undefined && (typeof reason !== 'string' || !FAIL_REASON.test(reason))) {
      invalid('INVALID_REASON', 'reason must be 1-64 characters of A-Z, a-z, 0-9, _ = , : . or -');
    }
    return { ok: false, readings: null, failReason: reason ?? null };
  }
  if (query.reason !== undefined) {
    invalid('REASON_NOT_ALLOWED', 'reason is only allowed with ok=0');
  }

  const temperature = readDecimal(query, 't', 'INVALID_TEMPERATURE', 'temperature', -40, 80);
  const humidity = readDecimal(query, 'h', 'INVALID_HUMIDITY', 'humidity', 0, 100);

  const rawLux = query.l;
  if (rawLux === undefined) invalid('INVALID_LUX', 'l (lux) is required when ok=1');
  if (typeof rawLux !== 'string' || !UNSIGNED_INTEGER.test(rawLux)) {
    invalid('INVALID_LUX', 'l (lux) must be a whole number between 0 and 65535');
  }
  const lux = Number(rawLux);
  if (lux > 65535) invalid('INVALID_LUX', 'l (lux) must be a whole number between 0 and 65535');

  return { ok: true, readings: { temperature, humidity, lux }, failReason: null };
}

/** Returns the `X-Upload-Id` header value, or null when the header is absent. */
export function parseUploadId(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  if (typeof header !== 'string' || !UPLOAD_ID.test(header)) {
    invalid('INVALID_UPLOAD_ID', 'X-Upload-Id must be 1-64 characters of A-Z, a-z, 0-9, _ or -');
  }
  return header;
}

export interface Cursor {
  /** `created_at` as text with microsecond precision, compared in SQL as timestamptz. */
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = /^[1-9]\d{0,18}$/;

function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      CURSOR_TIMESTAMP.test(parsed[0]) &&
      ID.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the error below.
  }
  invalid('INVALID_CURSOR', 'cursor is not valid; use nextCursor from a previous response');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function readDate(query: Query, key: 'from' | 'to'): Date | null {
  const raw = query[key];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !(DATE_ONLY.test(raw) || DATE_TIME.test(raw))) {
    invalid(
      'INVALID_DATE',
      `${key} must be an ISO 8601 date (2026-09-17) or date-time with offset`,
    );
  }
  const date = new Date(DATE_ONLY.test(raw) ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) invalid('INVALID_DATE', `${key} is not a valid date`);
  // A plain `to` date includes that whole UTC day.
  if (key === 'to' && DATE_ONLY.test(raw)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export interface DateRange {
  from: Date | null;
  /** Exclusive when `to` was a plain date (start of the next day), otherwise inclusive. */
  to: { date: Date; exclusive: boolean } | null;
}

/** Parses `from` and `to`; shared by the list, stats and export endpoints. */
export function parseRange(query: Query): DateRange {
  const from = readDate(query, 'from');
  const toDate = readDate(query, 'to');
  const to = toDate && { date: toDate, exclusive: DATE_ONLY.test(String(query.to)) };
  if (from && to && (to.exclusive ? from >= to.date : from > to.date))
    invalid('INVALID_DATE', 'from must be before to');
  return { from, to };
}

function parseStatus(query: Query): SampleStatusFilter {
  const status = query.status ?? 'all';
  if (status !== 'all' && status !== 'ok' && status !== 'failed') {
    invalid('INVALID_STATUS', 'status must be all, ok or failed');
  }
  return status;
}

export interface ListQuery extends DateRange {
  limit: number;
  cursor: Cursor | null;
  status: SampleStatusFilter;
  /** Null means samples with and without photos. */
  hasPhoto: boolean | null;
  order: SampleOrder;
}

export function parseListQuery(query: Query): ListQuery {
  let limit = 50;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d{1,3}$/.test(query.limit)) {
      invalid('INVALID_LIMIT', 'limit must be a whole number between 1 and 500');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > 500) invalid('INVALID_LIMIT', 'limit must be between 1 and 500');
  }

  let cursor: Cursor | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string') invalid('INVALID_CURSOR', 'cursor must be a string');
    cursor = decodeCursor(query.cursor);
  }

  let hasPhoto: boolean | null = null;
  if (query.hasPhoto !== undefined) {
    if (query.hasPhoto !== 'true' && query.hasPhoto !== 'false') {
      invalid('INVALID_HAS_PHOTO', 'hasPhoto must be true or false');
    }
    hasPhoto = query.hasPhoto === 'true';
  }

  const order = query.order ?? 'desc';
  if (order !== 'desc' && order !== 'asc') invalid('INVALID_ORDER', 'order must be desc or asc');

  return { limit, cursor, status: parseStatus(query), hasPhoto, order, ...parseRange(query) };
}

const TIMEZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/**
 * Returns the `tz` query value when it is shaped like a timezone name, or null when absent.
 * Whether Postgres knows the zone is checked separately (see services/timezones.ts).
 */
export function parseTimezoneParam(query: Query): string | null {
  const tz = query.tz;
  if (tz === undefined) return null;
  if (typeof tz !== 'string' || !TIMEZONE_NAME.test(tz)) {
    invalid('INVALID_TIMEZONE', 'tz must be an IANA timezone such as Asia/Dhaka');
  }
  return tz;
}

export interface ExportQuery extends DateRange {
  status: SampleStatusFilter;
  tz: string | null;
}

export function parseExportQuery(query: Query): ExportQuery {
  return { status: parseStatus(query), tz: parseTimezoneParam(query), ...parseRange(query) };
}

export interface StatsQuery extends DateRange {
  tz: string | null;
}

export function parseStatsQuery(query: Query): StatsQuery {
  return { tz: parseTimezoneParam(query), ...parseRange(query) };
}

const BINS = /^\d{1,2}$/;

export interface ExploreQuery extends DateRange {
  tz: string | null;
  bins: number;
}

export function parseExploreQuery(query: Query): ExploreQuery {
  let bins = 12;
  if (query.bins !== undefined) {
    if (typeof query.bins !== 'string' || !BINS.test(query.bins)) {
      invalid('INVALID_BINS', 'bins must be a whole number between 1 and 30');
    }
    bins = Number(query.bins);
    if (bins < 1 || bins > 30) invalid('INVALID_BINS', 'bins must be between 1 and 30');
  }
  return { tz: parseTimezoneParam(query), bins, ...parseRange(query) };
}

/** Parses a sample id path parameter; returns null when it cannot be a valid id. */
export function parseSampleId(raw: string): string | null {
  return ID.test(raw) && Number(raw) <= Number.MAX_SAFE_INTEGER ? raw : null;
}

const CLASSIFICATIONS = ['tree', 'object', 'unclear', 'error'] as const;
const MAX_NOTE_LENGTH = 300;

/** Validates the JSON body of `POST /api/samples/classification`. */
export function parseClassificationBody(body: unknown): {
  label: (typeof CLASSIFICATIONS)[number];
  note: string | null;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid('INVALID_BODY', 'Body must be a JSON object with a label');
  }
  const { label, note } = body as { label?: unknown; note?: unknown };
  if (typeof label !== 'string' || !(CLASSIFICATIONS as readonly string[]).includes(label)) {
    invalid('INVALID_LABEL', `label must be one of ${CLASSIFICATIONS.join(', ')}`);
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    invalid('INVALID_NOTE', 'note must be a string');
  }
  // Truncated rather than rejected: a long model answer is still worth keeping for debugging.
  const trimmed = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE_LENGTH) : '';
  return { label: label as (typeof CLASSIFICATIONS)[number], note: trimmed || null };
}

import type {
  Classification,
  NeighborsResponse,
  PlantHealth,
  Sample,
  SampleListResponse,
  SampleStatusFilter,
  UploadResponse,
} from '@sylvan/shared';
import type { Sql } from '../db/client.js';
import { encodeCursor, type DateRange, type ListQuery, type Readings } from '../lib/validation.js';
import type { PhotoStorage, StoredPhoto } from './photoStorage.js';

export interface SampleRow {
  id: string;
  created_at: Date;
  cursor_ts: string;
  ok: boolean;
  temperature: string | null;
  humidity: string | null;
  lux: number | null;
  photo_key: string | null;
  photo_bytes: number | null;
  fail_reason: string | null;
  classification: Classification | null;
  classification_note: string | null;
  classified_at: Date | null;
  ai_label: Classification | null;
  ai_health: PlantHealth | null;
  ai_health_confidence: number | null;
  ai_confidence: number | null;
  ai_model: string | null;
  ai_note: string | null;
  ai_classified_at: Date | null;
}

export interface CreateSampleInput {
  readings: Readings | null;
  uploadId: string | null;
  photo: Buffer | null;
  /** Only for failed samples: the cause reported by the rover. */
  failReason?: string | null;
}

export interface CreateSampleResult {
  /** False when a sample with the same upload id already existed. */
  created: boolean;
  response: UploadResponse;
}

export interface SamplesService {
  findUpload(uploadId: string): Promise<UploadResponse | null>;
  create(input: CreateSampleInput): Promise<CreateSampleResult>;
  list(query: ListQuery): Promise<SampleListResponse>;
  get(id: string): Promise<Sample | null>;
  neighbors(id: string): Promise<NeighborsResponse | null>;
  /** Sets the photo verdict for an upload; returns the updated sample, or null if unknown. */
  classify(uploadId: string, label: Classification, note: string | null): Promise<Sample | null>;
  /** The server's photo verdict for an upload, if it has one yet. */
  aiVerdictFor(uploadId: string): Promise<{
    label: Classification;
    health: PlantHealth | null;
    healthConfidence: number | null;
    confidence: number | null;
  } | null>;
}

const toNumber = (value: string | null) => (value === null ? null : Number(value));

export function toSample(row: SampleRow): Sample {
  return {
    id: Number(row.id),
    createdAt: row.created_at.toISOString(),
    ok: row.ok,
    temperature: toNumber(row.temperature),
    humidity: toNumber(row.humidity),
    lux: row.lux,
    photoUrl: row.photo_key === null ? null : `/photos/${row.photo_key}`,
    photoBytes: row.photo_bytes,
    failReason: row.fail_reason,
    classification: row.classification,
    classificationNote: row.classification_note,
    classifiedAt: row.classified_at === null ? null : row.classified_at.toISOString(),
    ai:
      row.ai_label === null || row.ai_classified_at === null
        ? null
        : {
            label: row.ai_label,
            health: row.ai_health,
            healthConfidence: row.ai_health_confidence,
            confidence: row.ai_confidence,
            model: row.ai_model,
            note: row.ai_note,
            classifiedAt: row.ai_classified_at.toISOString(),
          },
  };
}

/** SQL conditions (each starting with AND) for the shared status and date filters. */
export function sampleFilters(
  sql: Sql,
  { status = 'all', from, to }: DateRange & { status?: SampleStatusFilter },
) {
  return sql`
    ${status === 'ok' ? sql`AND ok` : status === 'failed' ? sql`AND NOT ok` : sql``}
    ${from ? sql`AND created_at >= ${from}` : sql``}
    ${to ? (to.exclusive ? sql`AND created_at < ${to.date}` : sql`AND created_at <= ${to.date}`) : sql``}
  `;
}

export const sampleColumns = (sql: Sql) => sql`
  id, created_at, ok, temperature, humidity, lux, photo_key, photo_bytes,
  fail_reason, classification, classification_note, classified_at,
  ai_label, ai_health, ai_health_confidence, ai_confidence, ai_model, ai_note, ai_classified_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
`;

export function createSamplesService(deps: {
  sql: Sql;
  storage: PhotoStorage;
  onCleanupError?: (error: unknown, key: string) => void;
}): SamplesService {
  const { sql, storage } = deps;

  const selectColumns = () => sampleColumns(sql);

  async function findUpload(uploadId: string): Promise<UploadResponse | null> {
    const [row] = await sql<{ id: string; photo_key: string | null }[]>`
      SELECT id, photo_key FROM samples WHERE upload_id = ${uploadId}
    `;
    return row ? { id: Number(row.id), photo: row.photo_key !== null } : null;
  }

  async function discardPhoto(photo: StoredPhoto | null) {
    if (!photo) return;
    try {
      await storage.remove(photo.key);
    } catch (error) {
      deps.onCleanupError?.(error, photo.key);
    }
  }

  return {
    findUpload,

    async create({ readings, uploadId, photo, failReason = null }) {
      const stored = photo ? await storage.save(photo) : null;

      let inserted: { id: string }[];
      try {
        inserted = await sql<{ id: string }[]>`
          INSERT INTO samples
            (upload_id, ok, temperature, humidity, lux, photo_key, photo_bytes, fail_reason)
          VALUES (
            ${uploadId}, ${readings !== null},
            ${readings?.temperature ?? null}, ${readings?.humidity ?? null}, ${readings?.lux ?? null},
            ${stored?.key ?? null}, ${stored?.bytes ?? null},
            ${readings === null ? failReason : null}
          )
          ON CONFLICT (upload_id) DO NOTHING
          RETURNING id
        `;
      } catch (error) {
        await discardPhoto(stored);
        throw error;
      }

      const [row] = inserted;
      if (row) {
        return { created: true, response: { id: Number(row.id), photo: stored !== null } };
      }

      // Lost a race with a concurrent request carrying the same upload id.
      await discardPhoto(stored);
      const existing = uploadId === null ? null : await findUpload(uploadId);
      if (!existing) throw new Error('Upload id conflicted but no existing sample was found');
      return { created: false, response: existing };
    },

    async list({ limit, cursor, hasPhoto, order, ...filters }) {
      const after = cursor
        ? order === 'asc'
          ? sql`AND (created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::bigint)`
          : sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::bigint)`
        : sql``;
      const rows = await sql<SampleRow[]>`
        SELECT ${selectColumns()}
        FROM samples
        WHERE TRUE
          ${sampleFilters(sql, filters)}
          ${hasPhoto === null ? sql`` : hasPhoto ? sql`AND photo_key IS NOT NULL` : sql`AND photo_key IS NULL`}
          ${after}
        ORDER BY ${order === 'asc' ? sql`created_at ASC, id ASC` : sql`created_at DESC, id DESC`}
        LIMIT ${limit + 1}
      `;

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toSample),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ createdAt: last.cursor_ts, id: last.id })
            : null,
      };
    },

    async get(id) {
      const [row] = await sql<
        SampleRow[]
      >`SELECT ${selectColumns()} FROM samples WHERE id = ${id}::bigint`;
      return row ? toSample(row) : null;
    },

    async neighbors(id) {
      const [row] = await sql<{ previous_id: string | null; next_id: string | null }[]>`
        SELECT
          (SELECT p.id FROM samples p
            WHERE (p.created_at, p.id) < (c.created_at, c.id)
            ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS previous_id,
          (SELECT n.id FROM samples n
            WHERE (n.created_at, n.id) > (c.created_at, c.id)
            ORDER BY n.created_at ASC, n.id ASC LIMIT 1) AS next_id
        FROM samples c
        WHERE c.id = ${id}::bigint
      `;
      if (!row) return null;
      return {
        previousId: row.previous_id === null ? null : Number(row.previous_id),
        nextId: row.next_id === null ? null : Number(row.next_id),
      };
    },

    async aiVerdictFor(uploadId) {
      const [row] = await sql<
        {
          ai_label: Classification | null;
          ai_health: PlantHealth | null;
          ai_health_confidence: number | null;
          ai_confidence: number | null;
        }[]
      >`
        SELECT ai_label, ai_health, ai_health_confidence, ai_confidence FROM samples
        WHERE upload_id = ${uploadId}
      `;
      return row?.ai_label
        ? {
            label: row.ai_label,
            health: row.ai_health,
            healthConfidence: row.ai_health_confidence,
            confidence: row.ai_confidence,
          }
        : null;
    },

    async classify(uploadId, label, note) {
      const [row] = await sql<SampleRow[]>`
        UPDATE samples
        SET classification = ${label}, classification_note = ${note}, classified_at = now()
        WHERE upload_id = ${uploadId}
        RETURNING ${selectColumns()}
      `;
      return row ? toSample(row) : null;
    },
  };
}
